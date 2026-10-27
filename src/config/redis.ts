import { Redis, type RedisOptions } from 'ioredis';
import type { RedisLike } from '../common/middleware/rateLimiter';
import type { DependencyHealth } from '../common/types/health';
import { logger } from '../common/utils/logger';
import { withTimeout } from '../common/utils/withTimeout';
import { env } from './env';

const CONNECT_TIMEOUT_MS = 10_000;
const PING_TIMEOUT_MS = 1_500;
const QUIT_TIMEOUT_MS = 3_000;
const MAX_RETRY_DELAY_MS = 5_000;
const ERROR_LOG_INTERVAL_MS = 30_000;

/** Reconnect delay: 200ms, 400ms, 600ms ... capped at 5s. Retries forever. */
export const redisRetryDelay = (attempt: number): number =>
  Math.min(attempt * 200, MAX_RETRY_DELAY_MS);

function attachLogging(client: Redis, label: string): void {
  let lastErrorLog = 0;

  // Without an 'error' listener, Node would crash the process on any Redis error.
  // While Redis is down, ioredis emits one per retry, so we log at most one every 30s.
  client.on('error', (err) => {
    const now = Date.now();
    if (now - lastErrorLog >= ERROR_LOG_INTERVAL_MS) {
      lastErrorLog = now;
      logger.error({ err, client: label }, 'redis error');
    }
  });
  client.on('ready', () => logger.info({ client: label }, 'redis ready'));
  client.on('close', () => logger.warn({ client: label }, 'redis connection closed'));
}

/**
 * Client for the API: cache, sessions, rate limits, idempotency.
 * It fails fast. When Redis is down, commands reject at once instead of queueing,
 * which is what lets login fail closed and reference reads fall back to MongoDB.
 */
export function createRedisClient(url: string = env.REDIS_URL, label = 'api'): Redis {
  const options: RedisOptions = {
    connectionName: `peacock-${label}`,
    connectTimeout: CONNECT_TIMEOUT_MS,
    retryStrategy: redisRetryDelay,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
  };
  const client = new Redis(url, options);
  attachLogging(client, label);
  return client;
}

/**
 * Connection for BullMQ queues and workers. BullMQ requires maxRetriesPerRequest: null
 * and needs commands queued through short outages, so it must not share the API client.
 * Used from the jobs module.
 */
export function createBullMQConnection(): Redis {
  const client = new Redis(env.REDIS_URL, {
    connectionName: 'peacock-bullmq',
    connectTimeout: CONNECT_TIMEOUT_MS,
    retryStrategy: redisRetryDelay,
    maxRetriesPerRequest: null,
  });
  attachLogging(client, 'bullmq');
  return client;
}

export async function connectRedisClient(
  client: Redis,
  timeoutMs: number = CONNECT_TIMEOUT_MS,
): Promise<void> {
  if (client.status === 'ready') return;

  try {
    await withTimeout(client.connect(), timeoutMs, 'Redis connect');
  } catch (err) {
    // Stop the background retries so a failed boot does not leave a live socket behind.
    client.disconnect();
    throw err;
  }
}

export async function pingRedisClient(client: Redis): Promise<DependencyHealth> {
  const started = performance.now();
  try {
    await withTimeout(client.ping(), PING_TIMEOUT_MS, 'Redis ping');
    return { ok: true, latencyMs: Math.round(performance.now() - started) };
  } catch {
    return { ok: false, latencyMs: Math.round(performance.now() - started) };
  }
}

export async function disconnectRedisClient(client: Redis): Promise<void> {
  if (client.status === 'end') return;
  if (client.status === 'wait') {
    client.disconnect();
    return;
  }
  try {
    // quit() lets in-flight commands finish. If it hangs, we cut the connection.
    await withTimeout(client.quit(), QUIT_TIMEOUT_MS, 'Redis quit');
  } catch {
    client.disconnect();
  }
}

/** The shared API client. Created now, connected only when server.ts calls connectRedis(). */
export const redis = createRedisClient();

export const connectRedis = (): Promise<void> => connectRedisClient(redis);
export const pingRedis = (): Promise<DependencyHealth> => pingRedisClient(redis);
export const disconnectRedis = (): Promise<void> => disconnectRedisClient(redis);

/** What the rate limiter needs from Redis, and nothing more. */
export const rateLimitRedis: RedisLike = {
  call: (command, ...args) => redis.call(command, ...args),
};