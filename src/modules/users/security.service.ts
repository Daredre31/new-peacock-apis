import { assertCanManageRole } from '../../common/scope';
import { AppError } from '../../common/errors/AppError';
import { USER_STATUS } from '../../config/constants';
import { recordSafely } from '../audit/audit.port';
import type { AuditService } from '../audit/audit.service';
import type { PasswordService } from '../auth/password.service';
import type { TokenService } from '../auth/token.service';
import type { userRepository } from './user.repository';

interface Actor { id: string; role: Express.AuthUser['role'] }
interface Context { ip: string; requestId: string }

const HISTORY_ACTIONS = [
  'AUTH_LOGIN_SUCCESS',
  'AUTH_LOGIN_FAILED',
  'AUTH_LOGIN_BLOCKED',
  'AUTH_ACCOUNT_LOCKED_OUT',
  'AUTH_LOGOUT',
  'AUTH_LOGOUT_ALL',
  'AUTH_PASSWORD_CHANGED',
  'AUTH_PASSWORD_RESET',
] as const;

export interface SecurityServiceDeps {
  users: Pick<typeof userRepository, 'findById' | 'findAuth' | 'setLocked' | 'unlock' | 'setPassword'>;
  passwords: Pick<PasswordService, 'generateTemporaryPassword' | 'hashPassword'>;
  tokens: Pick<TokenService, 'revokeAllSessions'>;
  audit: AuditService;
}

export function createSecurityService(deps: SecurityServiceDeps) {
  const { users, passwords, tokens, audit } = deps;

  /** The account must exist, and the actor's role must be allowed to manage that kind of account. */
  async function target(actor: Actor, id: string) {
    const user = await users.findById(id);
    if (!user) throw new AppError('NOT_FOUND');
    assertCanManageRole(actor.role, user.role);
    return user;
  }

  const log = (event: string, actor: Actor, ctx: Context, id: string) =>
    recordSafely(audit, { action: event, actorId: actor.id, entityType: 'user', entityId: id, ip: ctx.ip, requestId: ctx.requestId });

  async function statusOf(id: string) {
    const user = await users.findById(id);
    if (!user) throw new AppError('NOT_FOUND');
    return { id, status: user.status };
  }

  return {
    async lock(id: string, actor: Actor, ctx: Context) {
      await target(actor, id);
      await users.setLocked(id);
      await tokens.revokeAllSessions(id);
      await log('USER_LOCKED', actor, ctx, id);
      return statusOf(id);
    },

    async unlock(id: string, actor: Actor, ctx: Context) {
      await target(actor, id);
      const auth = await users.findAuth({ id });
      await users.unlock(id, auth?.passwordHash ? USER_STATUS.ACTIVE : USER_STATUS.INVITED);
      await log('USER_UNLOCKED', actor, ctx, id);
      return statusOf(id);
    },

    async forceLogout(id: string, actor: Actor, ctx: Context) {
      await target(actor, id);
      await tokens.revokeAllSessions(id);
      await log('USER_FORCE_LOGOUT', actor, ctx, id);
      return statusOf(id);
    },

    /** The new password is returned once and never stored or logged anywhere in readable form. */
    async resetPassword(id: string, actor: Actor, ctx: Context) {
      await target(actor, id);
      const temporaryPassword = passwords.generateTemporaryPassword();
      await users.setPassword(id, await passwords.hashPassword(temporaryPassword), { mustChangePassword: true });
      await tokens.revokeAllSessions(id);
      await log('USER_PASSWORD_RESET_BY_ADMIN', actor, ctx, id);
      return { temporaryPassword };
    },

    async loginHistory(id: string, input: { page: number; limit: number }) {
      if (!(await users.findById(id))) throw new AppError('NOT_FOUND');
      const { items, total } = await audit.list({
        actorId: id,
        actions: HISTORY_ACTIONS,
        page: input.page,
        limit: input.limit,
        sort: '-createdAt',
      });
      return {
        total,
        items: items.map((row) => ({ id: row.id, event: row.action, ip: row.ip, at: row.createdAt })),
      };
    },
  };
}

export type SecurityService = ReturnType<typeof createSecurityService>;