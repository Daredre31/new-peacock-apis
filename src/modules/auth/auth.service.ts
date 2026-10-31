import { AppError } from '../../common/errors/AppError';
import { parseIdentifier, type ParsedIdentifier } from '../../common/utils/identifier';
import { logger } from '../../common/utils/logger';
import { AUTH_LOCKOUT, USER_STATUS, type Role } from '../../config/constants';
import type { AuditEntry, AuditPort } from '../audit/audit.port';
import type { UserAuthRecord, UserRecord, userRepository } from '../users/user.repository';
import type { PasswordService } from './password.service';
import type { IssuedSession, TokenService } from './token.service';

type Users = Pick<
  typeof userRepository,
  'findAuth' | 'findById' | 'recordFailedLogin' | 'recordSuccessfulLogin' | 'replacePasswordHash'
>;
type Passwords = Pick<PasswordService, 'verifyPassword' | 'hashPassword'>;
type Tokens = Pick<
  TokenService,
  'issueSession' | 'rotateRefreshToken' | 'signAccessToken' | 'revokeSession' | 'revokeAllSessions'
>;

export interface AuthServiceDeps {
  users: Users;
  passwords: Passwords;
  tokens: Tokens;
  audit: AuditPort;
  now?: () => Date;
    /** Staff numbers now; registration numbers join in the students step. */
  loginIds: { findUserId(loginId: string): Promise<string | null> };
}

export interface RequestContext {
  ip: string;
  requestId: string;
}

export interface AuthUserView {
  id: string;
  role: Role;
  email: string | null;
  phone: string | null;
  emailVerified: boolean;
  phoneVerified: boolean;
  mustChangePassword: boolean;
}

type SessionTokens = Pick<
  IssuedSession,
  'accessToken' | 'accessExpiresAt' | 'refreshToken' | 'refreshExpiresAt'
>;

export type RefreshResult =
  | { kind: 'ok'; user: AuthUserView; session: SessionTokens }
  /** The same token arrived twice at once. The browser already has the new one. */
  | { kind: 'retry' }
  | { kind: 'denied' };

const toView = (user: UserRecord): AuthUserView => ({
  id: user.id,
  role: user.role,
  email: user.email,
  phone: user.phone,
  emailVerified: user.emailVerified,
  phoneVerified: user.phoneVerified,
  mustChangePassword: user.mustChangePassword,
});

export function createAuthService(deps: AuthServiceDeps) {
  const { users, passwords, tokens, audit } = deps;
  const clock = deps.now ?? (() => new Date());

  // Audit problems must never break a login or a logout.
  async function record(entry: AuditEntry): Promise<void> {
    try {
      await audit.record(entry);
    } catch (err) {
      logger.error({ err, action: entry.action }, 'audit write failed');
    }
  }

  async function findByIdentifier(identifier: ParsedIdentifier): Promise<UserAuthRecord | null> {
    switch (identifier.kind) {
      case 'email':
        return users.findAuth({ email: identifier.value });
      case 'phone':
        return users.findAuth({ phone: identifier.value });
            case 'id': {
        const userId = await deps.loginIds.findUserId(identifier.value);
        return userId ? users.findAuth({ id: userId }) : null;
      }
        return null;
    }
  }

  return {
    async login(input: { identifier: string; password: string } & RequestContext) {
      const { ip, requestId } = input;
      const parsed = parseIdentifier(input.identifier);
      const user = parsed ? await findByIdentifier(parsed) : null;

      // Always run the full password check, even for unknown accounts, so response time says nothing.
      const check = await passwords.verifyPassword(user?.passwordHash ?? null, input.password);

      const now = clock();
      // Never the identifier itself: people sometimes type their password into that box.
      const base = { ip, requestId, metadata: { identifierKind: parsed?.kind ?? 'unparsed' } };

      if (!user) {
        await record({ ...base, action: 'AUTH_LOGIN_FAILED', metadata: { ...base.metadata, reason: 'unknown' } });
        throw new AppError('INVALID_CREDENTIALS');
      }

      if (user.status === USER_STATUS.LOCKED) {
        await record({ ...base, action: 'AUTH_LOGIN_BLOCKED', actorId: user.id, metadata: { reason: 'locked' } });
        throw new AppError('ACCOUNT_LOCKED');
      }

      if (user.lockedUntil && user.lockedUntil > now) {
        await record({ ...base, action: 'AUTH_LOGIN_BLOCKED', actorId: user.id, metadata: { reason: 'lockout' } });
        const seconds = Math.ceil((user.lockedUntil.getTime() - now.getTime()) / 1000);
        throw new AppError('ACCOUNT_LOCKED', { retryAfter: Math.max(1, seconds) });
      }

      // Invited accounts have no password yet. Nothing to guess, so nothing to count.
      if (user.status !== USER_STATUS.ACTIVE) throw new AppError('INVALID_CREDENTIALS');

      if (!check.valid) {
        const updated = await users.recordFailedLogin(user.id, AUTH_LOCKOUT, now);
        const nowLocked = Boolean(updated?.lockedUntil && updated.lockedUntil > now);
        await record({
          ...base,
          action: nowLocked ? 'AUTH_ACCOUNT_LOCKED_OUT' : 'AUTH_LOGIN_FAILED',
          actorId: user.id,
        });
        throw new AppError('INVALID_CREDENTIALS');
      }

      await users.recordSuccessfulLogin(user.id, now);

      // The hash was made with older settings: quietly store a fresh one. A failure here changes nothing for the user.
      if (check.needsRehash) {
        try {
          await users.replacePasswordHash(user.id, await passwords.hashPassword(input.password));
        } catch (err) {
          logger.warn({ err }, 'password rehash failed');
        }
      }

      const session = await tokens.issueSession({
        userId: user.id,
        role: user.role,
        mustChangePassword: user.mustChangePassword,
      });

      await record({ ...base, action: 'AUTH_LOGIN_SUCCESS', actorId: user.id });
      return { user: toView(user), session };
    },

    async refresh(refreshToken: unknown, context: RequestContext): Promise<RefreshResult> {
      const rotation = await tokens.rotateRefreshToken(refreshToken);

      if (rotation.outcome === 'concurrent') return { kind: 'retry' };

      if (rotation.outcome === 'reused') {
        await record({
          ...context,
          action: 'AUTH_TOKEN_REUSE_DETECTED',
          actorId: rotation.userId,
          metadata: { sessionId: rotation.sessionId },
        });
        return { kind: 'denied' };
      }

      if (rotation.outcome === 'invalid') return { kind: 'denied' };

      // Role and status come from the database, never from the old token.
      const user = await users.findById(rotation.userId);
      if (!user || user.status !== USER_STATUS.ACTIVE) {
        await tokens.revokeSession(rotation.sessionId);
        return { kind: 'denied' };
      }

      const access = await tokens.signAccessToken({
        userId: user.id,
        role: user.role,
        sessionId: rotation.sessionId,
        mustChangePassword: user.mustChangePassword,
      });

      return {
        kind: 'ok',
        user: toView(user),
        session: {
          accessToken: access.accessToken,
          accessExpiresAt: access.accessExpiresAt,
          refreshToken: rotation.refreshToken,
          refreshExpiresAt: rotation.refreshExpiresAt,
        },
      };
    },

    async logout(user: { id: string; sessionId: string }, context: RequestContext): Promise<void> {
      await tokens.revokeSession(user.sessionId);
      await record({ ...context, action: 'AUTH_LOGOUT', actorId: user.id });
    },

    async logoutAll(userId: string, context: RequestContext): Promise<void> {
      await tokens.revokeAllSessions(userId);
      await record({ ...context, action: 'AUTH_LOGOUT_ALL', actorId: userId });
    },

    async getCurrentUser(userId: string): Promise<AuthUserView> {
      const user = await users.findById(userId);
      if (!user) throw new AppError('UNAUTHENTICATED');
      return toView(user);
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;