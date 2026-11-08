import { createHmac, randomBytes } from 'node:crypto';
import { AppError } from '../../common/errors/AppError';
import { parseIdentifier } from '../../common/utils/identifier';
import { logger } from '../../common/utils/logger';
import { assertPasswordPolicy } from '../../common/utils/passwordPolicy';
import { AUTH_LOCKOUT, SCHOOL_NAME, USER_STATUS } from '../../config/constants';
import type { Mailer } from '../../integrations/mailer';
import type { AuditEntry, AuditPort } from '../audit/audit.port';
import type { userRepository } from '../users/user.repository';
import type { RequestContext } from './auth.service';
import type { KeyValueStore } from './keyValueStore';
import type { PasswordService } from './password.service';
import type { TokenService } from './token.service';

type Users = Pick<typeof userRepository, 'findAuth' | 'findById' | 'recordFailedLogin' | 'setPassword'>;

export interface CredentialsServiceDeps {
  users: Users;
  passwords: Pick<PasswordService, 'verifyPassword' | 'hashPassword'>;
  tokens: Pick<TokenService, 'issueSession' | 'revokeAllSessions'>;
  audit: AuditPort;
  mailer: Mailer;
  store: KeyValueStore;
  /** Only a fingerprint of each reset token is stored. */
  secret: string;
  /** The frontend's origin, for the link in the email. */
  frontendOrigin: string;
  now?: () => Date;
  resetTtlSeconds?: number;
  inviteTtlSeconds?: number;
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

function parseRecord(raw: string | null): { userId: string; pwdAt: number } | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && 'userId' in value && 'pwdAt' in value) {
      const { userId, pwdAt } = value;
      if (typeof userId === 'string' && typeof pwdAt === 'number') return { userId, pwdAt };
    }
  } catch {
    // fall through
  }
  return null;
}

export function createCredentialsService(deps: CredentialsServiceDeps) {
  const { users, passwords, tokens, audit, mailer, store } = deps;
  const clock = deps.now ?? (() => new Date());
  const ttl = deps.resetTtlSeconds ?? 30 * 60;

  const inviteTtl = deps.inviteTtlSeconds ?? 7 * 24 * 60 * 60;
  const fingerprint = (token: string): string =>
    createHmac('sha256', deps.secret).update(`password-reset:${token}`).digest('hex');
  const keys = {
    token: (fp: string) => `auth:reset:${fp}`,
    // The one reset link that is currently valid for this user.
    latest: (userId: string) => `auth:reset-user:${userId}`,
  };

  async function record(entry: AuditEntry): Promise<void> {
    try {
      await audit.record(entry);
    } catch (err) {
      logger.error({ err, action: entry.action }, 'audit write failed');
    }
  }

    async function notify(to: string | null, subject: string, text: string): Promise<boolean> {
    if (!to) return false;
    try {
      await mailer.send({ to, subject, text });
      return true;
    } catch (err) {
      logger.error({ err }, 'email failed');
      return false;
    }
  }

  /** Stores a single-use link token for a user and returns it. A newer token replaces the older one. */
  async function storeToken(userId: string, passwordChangedAt: Date | null, ttlSeconds: number): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const fp = fingerprint(token);
    const previous = await store.get(keys.latest(userId));

    await store.setMany([
      {
        key: keys.token(fp),
        value: JSON.stringify({ userId, pwdAt: passwordChangedAt?.getTime() ?? 0 }),
        ttlSeconds,
      },
      { key: keys.latest(userId), value: fp, ttlSeconds },
    ]);
    if (previous && previous !== fp) await store.delete(keys.token(previous));
    return token;
  }

  const invalidLink = (): AppError =>
    new AppError('VALIDATION_ERROR', {
      details: [{ field: 'token', issue: 'This link is invalid or has expired' }],
    });

  return {
    /** Logged-in user changes their own password. Ends every other login and starts a fresh one. */
    async changePassword(input: { userId: string; currentPassword: string; newPassword: string } & RequestContext) {
      const now = clock();
      const user = await users.findAuth({ id: input.userId });
      if (!user || user.status !== USER_STATUS.ACTIVE) throw new AppError('UNAUTHENTICATED');

      if (user.lockedUntil && user.lockedUntil > now) {
        const seconds = Math.ceil((user.lockedUntil.getTime() - now.getTime()) / 1000);
        throw new AppError('ACCOUNT_LOCKED', { retryAfter: Math.max(1, seconds) });
      }

      // A stolen session must not be able to guess the current password freely: wrong guesses count toward the lockout.
      const check = await passwords.verifyPassword(user.passwordHash, input.currentPassword);
      if (!check.valid) {
        await users.recordFailedLogin(user.id, AUTH_LOCKOUT, now);
        await record({ action: 'AUTH_PASSWORD_CHANGE_FAILED', actorId: user.id, ip: input.ip, requestId: input.requestId });
        throw new AppError('VALIDATION_ERROR', {
          details: [{ field: 'currentPassword', issue: 'Incorrect password' }],
        });
      }

      if (input.newPassword === input.currentPassword) {
        throw new AppError('VALIDATION_ERROR', {
          details: [{ field: 'newPassword', issue: 'Must be different from the current password' }],
        });
      }
      assertPasswordPolicy(input.newPassword, { email: user.email, phone: user.phone });

      await users.setPassword(user.id, await passwords.hashPassword(input.newPassword), { mustChangePassword: false }, now);
      await tokens.revokeAllSessions(user.id);
      const session = await tokens.issueSession({ userId: user.id, role: user.role, mustChangePassword: false });

      await record({ action: 'AUTH_PASSWORD_CHANGED', actorId: user.id, ip: input.ip, requestId: input.requestId });
      await notify(
        user.email,
        `Your ${SCHOOL_NAME} password was changed`,
        'Your password was just changed. If this was not you, contact the school administrator immediately.',
      );
      return { session };
    },
        /** Emails a link for choosing a first password. Returns false when the email could not be sent. */
    async issueInvite(input: { userId: string; email: string; name: string }): Promise<boolean> {
      const token = await storeToken(input.userId, null, inviteTtl);
      const link = `${deps.frontendOrigin}/set-password#token=${token}`;
      return notify(
        input.email,
        `Welcome to ${SCHOOL_NAME}: choose your password`,
        `Hello ${input.name},\n\nAn account was created for you. Use this link to choose your password. It works once and expires in ${Math.round(inviteTtl / 86400)} days:\n\n${link}\n\nIf you were not expecting this, ignore this email.`,
      );
    },

    /**
     * Never reveals whether an account exists: it always returns normally.
     * Only active accounts that have both a password and an email get a link.
     */
    async requestPasswordReset(input: { identifier: string } & RequestContext): Promise<void> {
      const parsed = parseIdentifier(input.identifier);
      if (!parsed || parsed.kind === 'id') return;

      const user = await users.findAuth(parsed.kind === 'email' ? { email: parsed.value } : { phone: parsed.value });
      if (!user || user.status !== USER_STATUS.ACTIVE || !user.passwordHash || !user.email) return;

      const token = await storeToken(user.id, user.passwordChangedAt, ttl);

      // The token sits after "#", so it is never sent to a server and never appears in referrer headers.
      const link = `${deps.frontendOrigin}/reset-password#token=${token}`;
      await notify(
        user.email,
        `Reset your ${SCHOOL_NAME} password`,
        `Use this link to choose a new password. It works once and expires in ${Math.round(ttl / 60)} minutes:\n\n${link}\n\nIf you did not ask for this, ignore this email: your password has not changed.`,
      );
      await record({ action: 'AUTH_PASSWORD_RESET_REQUESTED', actorId: user.id, ip: input.ip, requestId: input.requestId });
    },

    async resetPassword(input: { token: string; newPassword: string } & RequestContext): Promise<void> {
      if (!TOKEN.test(input.token)) throw invalidLink();
      const key = keys.token(fingerprint(input.token));

      const peek = parseRecord(await store.get(key));
      if (!peek) throw invalidLink();

      const user = await users.findById(peek.userId);
      // A password change since the link was issued kills the link.
           if (
        !user ||
        (user.status !== USER_STATUS.ACTIVE && user.status !== USER_STATUS.INVITED) ||
        (user.passwordChangedAt?.getTime() ?? 0) !== peek.pwdAt
      ) {
        throw invalidLink();
      }

      // Checked before the link is used up, so a too-weak password does not waste it.
      assertPasswordPolicy(input.newPassword, { email: user.email, phone: user.phone });

      // Atomic: of two simultaneous uses of the same link, only one gets the record.
      if (!parseRecord(await store.getAndDelete(key))) throw invalidLink();
      await store.delete(keys.latest(user.id));

      await users.setPassword(user.id, await passwords.hashPassword(input.newPassword), { mustChangePassword: false });
      await tokens.revokeAllSessions(user.id);

      await record({ action: 'AUTH_PASSWORD_RESET', actorId: user.id, ip: input.ip, requestId: input.requestId });
      await notify(
        user.email,
        `Your ${SCHOOL_NAME} password was changed`,
        'Your password was just reset. If this was not you, contact the school administrator immediately.',
      );
    },
  };
}

export type CredentialsService = ReturnType<typeof createCredentialsService>;