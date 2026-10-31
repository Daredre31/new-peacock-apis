import { AppError } from '../../common/errors/AppError';
import { normalizeEmail, normalizePhone } from '../../common/utils/identifier';
import { ROLES, USER_STATUS } from '../../config/constants';
import { withTransaction } from '../../config/db';
import { recordSafely, type AuditPort } from '../audit/audit.port';
import type { CredentialsService } from '../auth/credentials.service';
import type { PasswordService } from '../auth/password.service';
import type { TokenService } from '../auth/token.service';
import type { ParentRecord, ParentSort, parentRepository } from './parent.repository';
import type { UserRecord, userRepository } from './user.repository';

interface Actor { id: string }
interface Context { ip: string; requestId: string }

export interface CreateParentInput {
  firstName: string;
  lastName: string;
  address?: string | undefined;
  email?: string | undefined;
  phone?: string | undefined;
  delivery: 'TEMPORARY_PASSWORD' | 'EMAIL_INVITE';
}
export type UpdateParentInput = Partial<Omit<CreateParentInput, 'delivery'>>;

export interface ParentServiceDeps {
  users: Pick<typeof userRepository, 'create' | 'findById' | 'findManyByIds' | 'updateContact' | 'softDelete'>;
  parents: typeof parentRepository;
  passwords: Pick<PasswordService, 'generateTemporaryPassword' | 'hashPassword'>;
  credentials: Pick<CredentialsService, 'issueInvite'>;
  tokens: Pick<TokenService, 'revokeAllSessions'>;
  audit: AuditPort;
}

const fail = (field: string, issue: string): AppError =>
  new AppError('VALIDATION_ERROR', { details: [{ field, issue }] });

function toView(p: ParentRecord, user: UserRecord) {
  return {
    id: user.id,
    firstName: p.firstName,
    lastName: p.lastName,
    address: p.address,
    email: user.email,
    emailVerified: user.emailVerified,
    phone: user.phone,
    status: user.status,
    mustChangePassword: user.mustChangePassword,
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
    createdAt: user.createdAt.toISOString(),
  };
}
export type ParentView = ReturnType<typeof toView>;

export function createParentService(deps: ParentServiceDeps) {
  const { users, parents, passwords, credentials, tokens, audit } = deps;

  const log = (event: string, actor: Actor, ctx: Context, id: string, before: object | null, after: object | null) =>
    recordSafely(audit, {
      action: `PARENT_${event}`, actorId: actor.id, entityType: 'user', entityId: id, ip: ctx.ip, requestId: ctx.requestId,
      before: before as Record<string, unknown> | null, after: after as Record<string, unknown> | null,
    });

  async function load(userId: string) {
    const parent = await parents.findByUserId(userId);
    const user = parent ? await users.findById(userId) : null;
    if (!parent || !user) throw new AppError('NOT_FOUND');
    return { parent, user };
  }

  return {
    async list(input: { page: number; limit: number; sort: ParentSort; q?: string | undefined }) {
      const { items, total } = await parents.list({ q: input.q }, { page: input.page, limit: input.limit, sort: input.sort });
      const found = new Map((await users.findManyByIds(items.map((p) => p.userId))).map((u) => [u.id, u]));
      return { total, items: items.flatMap((p) => { const u = found.get(p.userId); return u ? [toView(p, u)] : []; }) };
    },

    async get(userId: string): Promise<ParentView> {
      const { parent, user } = await load(userId);
      return toView(parent, user);
    },

    async create(input: CreateParentInput, actor: Actor, ctx: Context) {
      const email = input.email !== undefined ? normalizeEmail(input.email) : undefined;
      if (input.email !== undefined && !email) throw fail('email', 'Invalid email address');
      const phone = input.phone !== undefined ? normalizePhone(input.phone) : undefined;
      if (input.phone !== undefined && !phone) throw fail('phone', 'Invalid phone number');
      if (!email && !phone) throw fail('phone', 'Give a phone number, an email, or both');
      if (input.delivery === 'EMAIL_INVITE' && !email) throw fail('email', 'An email address is required to send an invite');

      const useTemporary = input.delivery === 'TEMPORARY_PASSWORD';
      const temporaryPassword = useTemporary ? passwords.generateTemporaryPassword() : null;
      const passwordHash = temporaryPassword ? await passwords.hashPassword(temporaryPassword) : undefined;
      const profile = { firstName: input.firstName, lastName: input.lastName, ...(input.address ? { address: input.address } : {}) };

      const { user, parent } = await withTransaction(async (tx) => {
        const created = await users.create(
          {
            ...(email ? { email } : {}), ...(phone ? { phone } : {}), ...(passwordHash ? { passwordHash } : {}),
            role: ROLES.PARENT,
            status: useTemporary ? USER_STATUS.ACTIVE : USER_STATUS.INVITED,
            mustChangePassword: useTemporary,
          },
          new Date(),
          tx,
        );
        return { user: created, parent: await parents.create({ userId: created.id, profile }, tx) };
      });

      const view = toView(parent, user);
      const inviteEmailSent = !useTemporary && email ? await credentials.issueInvite({ userId: user.id, email, name: input.firstName }) : null;
      await log('CREATED', actor, ctx, user.id, null, view);
      return { account: view, temporaryPassword, inviteEmailSent };
    },

    async update(userId: string, patch: UpdateParentInput, actor: Actor, ctx: Context): Promise<ParentView> {
      if (Object.values(patch).every((v) => v === undefined)) throw fail('body', 'Nothing to update');
      const before = await load(userId);

      const email = patch.email !== undefined ? normalizeEmail(patch.email) : undefined;
      if (patch.email !== undefined && !email) throw fail('email', 'Invalid email address');
      const phone = patch.phone !== undefined ? normalizePhone(patch.phone) : undefined;
      if (patch.phone !== undefined && !phone) throw fail('phone', 'Invalid phone number');

      const contact = {
        ...(email && email !== before.user.email ? { email } : {}),
        ...(phone && phone !== before.user.phone ? { phone } : {}),
      };
      const profile = {
        ...(patch.firstName !== undefined ? { firstName: patch.firstName } : {}),
        ...(patch.lastName !== undefined ? { lastName: patch.lastName } : {}),
        ...(patch.address !== undefined ? { address: patch.address } : {}),
      };

      await withTransaction(async (tx) => {
        if (Object.keys(contact).length > 0 && !(await users.updateContact(userId, contact, tx))) throw new AppError('NOT_FOUND');
        if (Object.keys(profile).length > 0) await parents.updateProfile(userId, profile, tx);
      });

      const after = await load(userId);
      const view = toView(after.parent, after.user);
      await log('UPDATED', actor, ctx, userId, toView(before.parent, before.user), view);
      return view;
    },

    async remove(userId: string, actor: Actor, ctx: Context): Promise<void> {
      const { parent, user } = await load(userId);
      const now = new Date();
      await withTransaction(async (tx) => {
        await users.softDelete(userId, now, tx);
        await parents.softDelete(userId, now, tx);
      });
      await tokens.revokeAllSessions(userId);
      await log('DELETED', actor, ctx, userId, toView(parent, user), null);
    },
  };
}

export type ParentService = ReturnType<typeof createParentService>;