import { createHmac, randomBytes } from 'node:crypto';
import { errors, jwtVerify, SignJWT } from 'jose';
import { AppError, isAppError } from '../../common/errors/AppError';
import { withTimeout } from '../../common/utils/withTimeout';
import { AUTH_TTL, isRole, type Role } from '../../config/constants';
import type { KeyValueStore } from './keyValueStore';

const ISSUER = 'peacock-academy-api';
const AUDIENCE = 'peacock-academy-web';
const MAX_ACCESS_TOKEN_LENGTH = 2048;
const REFRESH_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SESSION_ID = /^[a-f0-9]{32}$/;
const USER_ID = /^[a-f0-9]{24}$/;
const MIN_SECRET_LENGTH = 32;

export interface TokenServiceOptions {
  store: KeyValueStore;
  accessSecret: string;
  /** Used to fingerprint refresh tokens before they are stored. */
  refreshSecret: string;
  /** Milliseconds. Replaceable so tests can move time. */
  now?: () => number;
  accessTtlSeconds?: number;
  refreshTtlSeconds?: number;
  maxSessionSeconds?: number;
  reuseGraceMs?: number;
  storeTimeoutMs?: number;
}

export interface AccessTokenInput {
  userId: string;
  role: Role;
  sessionId: string;
  mustChangePassword: boolean;
}

export interface AccessClaims extends AccessTokenInput {
  issuedAt: Date;
  expiresAt: Date;
}

export type AccessVerification =
  | { ok: true; claims: AccessClaims }
  | { ok: false; reason: 'expired' | 'invalid' };

export interface IssuedSession {
  sessionId: string;
  accessToken: string;
  accessExpiresAt: Date;
  refreshToken: string;
  refreshExpiresAt: Date;
}

export type RotationResult =
  | { outcome: 'rotated'; userId: string; sessionId: string; refreshToken: string; refreshExpiresAt: Date }
  /** Unknown, expired, malformed, or its login was ended. Treat as "log in again". */
  | { outcome: 'invalid' }
  /** The same token arrived twice within a moment. Not theft: the browser already holds the new one. */
  | { outcome: 'concurrent' }
  /** An old token came back after its grace period. The whole login has been revoked. */
  | { outcome: 'reused'; userId: string; sessionId: string };

const INVALID = { outcome: 'invalid' } as const;
const INVALID_ACCESS = { ok: false, reason: 'invalid' } as const;

type Json = Record<string, unknown>;

function parseJson(raw: string | null): Json | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
  } catch {
    return null;
  }
}

const asFamily = (r: Json | null) =>
  r && typeof r.userId === 'string' && typeof r.createdAt === 'number'
    ? { userId: r.userId, createdAt: r.createdAt }
    : null;

const asRefresh = (r: Json | null) =>
  r && typeof r.sid === 'string' && typeof r.userId === 'string' ? { sid: r.sid, userId: r.userId } : null;

const asUsed = (r: Json | null) =>
  r && typeof r.sid === 'string' && typeof r.userId === 'string' && typeof r.usedAt === 'number'
    ? { sid: r.sid, userId: r.userId, usedAt: r.usedAt }
    : null;

export function createTokenService(options: TokenServiceOptions) {
  if (options.accessSecret.length < MIN_SECRET_LENGTH || options.refreshSecret.length < MIN_SECRET_LENGTH) {
    throw new Error(`Token secrets must be at least ${MIN_SECRET_LENGTH} characters`);
  }

  const { store } = options;
  const now = options.now ?? Date.now;
  const accessTtl = options.accessTtlSeconds ?? AUTH_TTL.accessSeconds;
  const refreshTtl = options.refreshTtlSeconds ?? AUTH_TTL.refreshSeconds;
  const maxSession = options.maxSessionSeconds ?? AUTH_TTL.maxSessionSeconds;
  const graceMs = options.reuseGraceMs ?? AUTH_TTL.reuseGraceMs;
  const timeoutMs = options.storeTimeoutMs ?? 2_000;
  const signingKey = new TextEncoder().encode(options.accessSecret);

  const keys = {
    /** One per login. While it exists, the login is alive. */
    family: (sid: string) => `auth:family:${sid}`,
    /** The one refresh token that is currently valid for a login. */
    refresh: (hash: string) => `auth:rt:${hash}`,
    /** A refresh token that has already been swapped for a new one. */
    used: (hash: string) => `auth:used:${hash}`,
    /** "Everything this user logged in before this moment is ended." */
    epoch: (userId: string) => `auth:epoch:${userId}`,
  };

  // Only a fingerprint of a refresh token is ever stored, so a Redis leak does not hand out working tokens.
  const fingerprint = (token: string): string =>
    createHmac('sha256', options.refreshSecret).update(token).digest('hex');

  const newRefreshToken = (): string => randomBytes(32).toString('base64url');

  // Redis failure or a hung connection becomes SERVICE_UNAVAILABLE: sessions fail closed.
  async function guard<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await withTimeout(operation(), timeoutMs, 'Session store');
    } catch (err) {
      if (isAppError(err)) throw err;
      throw new AppError('SERVICE_UNAVAILABLE', { cause: err });
    }
  }

  async function revokedByEpoch(userId: string, createdAt: number): Promise<boolean> {
    const raw = await store.get(keys.epoch(userId));
    if (raw === null) return false;
    const epoch = Number(raw);
    // Strictly earlier: a login created in the same millisecond as a revoke survives it,
    // which is what lets "change password" end old sessions and then start a new one.
    return Number.isFinite(epoch) && createdAt < epoch;
  }

  async function signAccessToken(input: AccessTokenInput) {
    const issuedAt = Math.floor(now() / 1000);
    const expiresAt = issuedAt + accessTtl;

    const accessToken = await new SignJWT({
      role: input.role,
      sid: input.sessionId,
      mcp: input.mustChangePassword,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(input.userId)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .sign(signingKey);

    return { accessToken, accessExpiresAt: new Date(expiresAt * 1000) };
  }

  return {
    signAccessToken,

    /** Starts a brand new login: a session record, a first refresh token and an access token. */
    async issueSession(input: Omit<AccessTokenInput, 'sessionId'>): Promise<IssuedSession> {
      const sessionId = randomBytes(16).toString('hex');
      const refreshToken = newRefreshToken();
      const createdAt = now();
      const refreshSeconds = Math.min(refreshTtl, maxSession);

      await guard(() =>
        store.setMany([
          {
            key: keys.family(sessionId),
            value: JSON.stringify({ userId: input.userId, createdAt }),
            ttlSeconds: maxSession,
          },
          {
            key: keys.refresh(fingerprint(refreshToken)),
            value: JSON.stringify({ sid: sessionId, userId: input.userId }),
            ttlSeconds: refreshSeconds,
          },
        ]),
      );

      const access = await signAccessToken({ ...input, sessionId });
      return {
        sessionId,
        ...access,
        refreshToken,
        refreshExpiresAt: new Date(createdAt + refreshSeconds * 1000),
      };
    },

    /** Checks signature, issuer, audience, expiry and the shape of every claim. Never throws. */
    async verifyAccessToken(token: unknown): Promise<AccessVerification> {
      if (typeof token !== 'string' || token.length === 0 || token.length > MAX_ACCESS_TOKEN_LENGTH) {
        return INVALID_ACCESS;
      }

      try {
        const { payload } = await jwtVerify(token, signingKey, {
          algorithms: ['HS256'], // anything else, including "none", is refused
          issuer: ISSUER,
          audience: AUDIENCE,
          currentDate: new Date(now()),
          clockTolerance: 5,
        });

        const { sub, role, sid, mcp, iat, exp } = payload;
        if (
          typeof sub !== 'string' || !USER_ID.test(sub) ||
          !isRole(role) ||
          typeof sid !== 'string' || !SESSION_ID.test(sid) ||
          typeof mcp !== 'boolean' ||
          typeof iat !== 'number' || typeof exp !== 'number'
        ) {
          return INVALID_ACCESS;
        }

        return {
          ok: true,
          claims: {
            userId: sub,
            role,
            sessionId: sid,
            mustChangePassword: mcp,
            issuedAt: new Date(iat * 1000),
            expiresAt: new Date(exp * 1000),
          },
        };
      } catch (err) {
        // Only reported as expired when the signature was already valid.
        if (err instanceof errors.JWTExpired) return { ok: false, reason: 'expired' };
        return INVALID_ACCESS;
      }
    },

    /** Is this login still alive? Not logged out, not force-logged-out, not past its hard cap. */
    async isSessionActive(claims: Pick<AccessClaims, 'userId' | 'sessionId'>): Promise<boolean> {
      return guard(async () => {
        const family = asFamily(parseJson(await store.get(keys.family(claims.sessionId))));
        if (!family || family.userId !== claims.userId) return false;
        return !(await revokedByEpoch(family.userId, family.createdAt));
      });
    },

    /** Swaps a refresh token for a new one, and detects tokens that are replayed. */
    async rotateRefreshToken(token: unknown): Promise<RotationResult> {
      if (typeof token !== 'string' || !REFRESH_TOKEN.test(token)) return INVALID;
      const hash = fingerprint(token);

      return guard(async (): Promise<RotationResult> => {
        // Atomic: of two requests carrying the same token, only one receives the record.
        const current = asRefresh(parseJson(await store.getAndDelete(keys.refresh(hash))));

        if (current) {
          const family = asFamily(parseJson(await store.get(keys.family(current.sid))));
          if (!family || family.userId !== current.userId) return INVALID;
          if (await revokedByEpoch(family.userId, family.createdAt)) return INVALID;

          const at = now();
          const remaining = Math.floor((family.createdAt + maxSession * 1000 - at) / 1000);
          if (remaining < 1) return INVALID;

          const refreshSeconds = Math.min(refreshTtl, remaining);
          const next = newRefreshToken();

          await store.setMany([
            {
              key: keys.used(hash),
              value: JSON.stringify({ sid: current.sid, userId: current.userId, usedAt: at }),
              ttlSeconds: refreshTtl,
            },
            {
              key: keys.refresh(fingerprint(next)),
              value: JSON.stringify({ sid: current.sid, userId: current.userId }),
              ttlSeconds: refreshSeconds,
            },
          ]);

          return {
            outcome: 'rotated',
            userId: current.userId,
            sessionId: current.sid,
            refreshToken: next,
            refreshExpiresAt: new Date(at + refreshSeconds * 1000),
          };
        }

        // Not a live token. Was it one we already swapped out?
        const used = asUsed(parseJson(await store.get(keys.used(hash))));
        if (!used) return INVALID;

        if (now() - used.usedAt <= graceMs) return { outcome: 'concurrent' };

        // A used token came back late: someone kept a copy. End the whole login.
        await store.delete(keys.family(used.sid));
        return { outcome: 'reused', userId: used.userId, sessionId: used.sid };
      });
    },

    /** Logout: ends this one login. */
    async revokeSession(sessionId: string): Promise<void> {
      if (!SESSION_ID.test(sessionId)) return;
      await guard(() => store.delete(keys.family(sessionId)));
    },

    /** Logout everywhere, force logout, password reset: ends every login this user has right now. */
    async revokeAllSessions(userId: string): Promise<void> {
      if (!USER_ID.test(userId)) return;
      await guard(() =>
        store.setMany([{ key: keys.epoch(userId), value: String(now()), ttlSeconds: maxSession }]),
      );
    },
  };
}

export type TokenService = ReturnType<typeof createTokenService>;