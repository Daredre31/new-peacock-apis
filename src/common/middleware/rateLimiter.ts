import { createHash } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { RedisStore, type RedisReply, type SendCommandFn } from 'rate-limit-redis';
import { withTimeout } from '../utils/withTimeout';
import { AppError, isAppError } from '../errors/AppError';
import { parseIdentifier } from '../utils/identifier'

/** The only thing the limiter needs from ioredis. */
export interface RedisLike {
  call(command: string, ...args: string[]): Promise<unknown>;
}

export const RATE_LIMITS = {
  // Spec: 5 attempts per 15 minutes per IP and email.
  login: { windowMs: 15 * 60 * 1000, limit: 5 },
  // Spec: 300 requests per minute per user (mounted after authenticate).
  user: { windowMs: 60 * 1000, limit: 300 },
  // Flood guard for everyone, logged in or not. Deliberately generous:
  // a whole school can sit behind one public IP.
  ip: { windowMs: 60 * 1000, limit: 1000 },
} as const;

const DEFAULT_REDIS_TIMEOUT_MS = 1500;
const HEALTH_PATHS = new Set(['/api/v1/health', '/api/v1/ready']);

  

export interface RateLimiterOptions {
  /** Used in the Redis key prefix and in logs. */
  name: string;
  windowMs: number;
  limit: number;
  key: (req: Request) => string;
  /** null means in-process memory only. Meant for unit tests. */
  redis: RedisLike | null;
  /** What to do when Redis cannot be reached. */
  onRedisFailure: 'fail-closed' | 'use-memory';
  skip?: (req: Request) => boolean;
  redisTimeoutMs?: number;
}

export function createRateLimiter(options: RateLimiterOptions): RequestHandler {
  const { name, windowMs, limit, key, redis, onRedisFailure, skip } = options;
  const timeoutMs = options.redisTimeoutMs ?? DEFAULT_REDIS_TIMEOUT_MS;

  const base = {
    windowMs,
    limit,
    standardHeaders: 'draft-6' as const,
    legacyHeaders: false,
    passOnStoreError: false, // store failures come to us, and we decide what happens
    keyGenerator: (req: Request): string => key(req),
    skip,
    handler: (
      req: Request,
      _res: unknown,
      next: (err?: unknown) => void,
      limiterOptions: { windowMs: number },
    ): void => {
      const info = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit;
      const seconds = info?.resetTime
        ? Math.ceil((info.resetTime.getTime() - Date.now()) / 1000)
        : Math.ceil(limiterOptions.windowMs / 1000);
      next(new AppError('RATE_LIMITED', { retryAfter: Math.max(1, seconds) }));
    },
  };

  if (!redis) {
    return rateLimit(base);
  }

      const sendCommand: SendCommandFn = (command, ...args) =>
    withTimeout(redis.call(command, ...args) as Promise<RedisReply>, timeoutMs, 'Redis command');

  const redisLimiter = rateLimit({
    ...base,
    store: new RedisStore({ sendCommand, prefix: `rl:${name}:` }),
  });
  const memoryLimiter = onRedisFailure === 'use-memory' ? rateLimit(base) : null;

  return (req, res, next) => {
    redisLimiter(req, res, (err?: unknown) => {
      // No error, or our own deliberate RATE_LIMITED: pass straight through.
      if (err === undefined || isAppError(err)) {
        next(err);
        return;
      }

      // Anything else is a Redis or store failure.
      req.log.error({ err, limiter: name }, 'rate limiter store failed');

      if (memoryLimiter) {
        memoryLimiter(req, res, next);
        return;
      }
      next(new AppError('SERVICE_UNAVAILABLE', { cause: err }));
    });
  };
}

const clientIp = (req: Request): string => ipKeyGenerator(req.ip ?? 'unknown');

// The identifier is normalised and hashed, so raw values never reach Redis and the key length is bounded.
function identifierKey(req: Request): string {
  const body: unknown = req.body;
  const raw =
    body !== null && typeof body === 'object' && 'identifier' in body && typeof body.identifier === 'string'
      ? body.identifier
      : '';
  const normalized = parseIdentifier(raw)?.value ?? raw.trim().toLowerCase();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

/** Mount on login only, after the JSON body parser. Fails closed if Redis is down. */
export const createLoginRateLimiter = (redis: RedisLike | null): RequestHandler =>
  createRateLimiter({
    name: 'login',
    ...RATE_LIMITS.login,
    key: (req) => `${clientIp(req)}|${identifierKey(req)}`,
    redis,
    onRedisFailure: 'fail-closed',
  });

/** Global flood guard for app.ts. If Redis is down it falls back to per-instance memory. */
export const createIpRateLimiter = (redis: RedisLike | null): RequestHandler =>
  createRateLimiter({
    name: 'ip',
    ...RATE_LIMITS.ip,
    key: clientIp,
    redis,
    onRedisFailure: 'use-memory',
    skip: (req) => HEALTH_PATHS.has(req.path),
  });
  /** 300 requests per minute per user. authenticate runs it, so req.user is always set by then. */
export const createUserRateLimiter = (redis: RedisLike | null): RequestHandler =>
  createRateLimiter({
    name: 'user',
    ...RATE_LIMITS.user,
    key: (req) => req.user?.id ?? clientIp(req),
    redis,
    onRedisFailure: 'use-memory',
  });
  /** Per IP and identifier, plus a cap per identifier alone, so rotating IPs cannot mail-bomb someone. */
export const createForgotPasswordRateLimiters = (redis: RedisLike | null): RequestHandler[] => [
  createRateLimiter({
    name: 'forgot-ip',
    windowMs: 15 * 60 * 1000,
    limit: 5,
    key: (req) => `${clientIp(req)}|${identifierKey(req)}`,
    redis,
    onRedisFailure: 'fail-closed',
  }),
  createRateLimiter({
    name: 'forgot-id',
    windowMs: 60 * 60 * 1000,
    limit: 5,
    key: identifierKey,
    redis,
    onRedisFailure: 'fail-closed',
  }),
];