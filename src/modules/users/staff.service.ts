import { AppError } from '../../common/errors/AppError';
import { normalizeEmail, normalizePhone } from '../../common/utils/identifier';
import { ROLES, USER_STATUS } from '../../config/constants';
import { withTransaction } from '../../config/db';
import { recordSafely, type AuditPort } from '../audit/audit.port';
import type { CredentialsService } from '../auth/credentials.service';
import type { PasswordService } from '../auth/password.service';
import type { TokenService } from '../auth/token.service';
import { STAFF_TYPES, type Gender, type StaffType } from './staff.model';
import type { StaffRecord, StaffSort, staffRepository } from './staff.repository';
import type { UserRecord, userRepository } from './user.repository';

interface Actor { id: string }
interface Context { ip: string; requestId: string }

interface ProfileFields {
  firstName: string;
  lastName: string;
  gender?: Gender | undefined;
  dateOfBirth?: string | undefined;
  address?: string | undefined;
}
interface ContactFields {
  email?: string | undefined;
  phone?: string | undefined;
}
export type CreateStaffInput = ProfileFields &
  ContactFields & { delivery: 'TEMPORARY_PASSWORD' | 'EMAIL_INVITE' };
export type UpdateStaffInput = Partial<ProfileFields> & ContactFields;

export interface StaffServiceDeps {
  users: Pick<typeof userRepository, 'create' | 'findById' | 'findManyByIds' | 'updateContact' | 'softDelete'>;
  staff: typeof staffRepository;
  passwords: Pick<PasswordService, 'generateTemporaryPassword' | 'hashPassword'>;
  credentials: Pick<CredentialsService, 'issueInvite'>;
  tokens: Pick<TokenService, 'revokeAllSessions'>;
  audit: AuditPort;
}

const fail = (field: string, issue: string): AppError =>
  new AppError('VALIDATION_ERROR', { details: [{ field, issue }] });

function toView(staff: StaffRecord, user: UserRecord) {
  return {
    id: user.id,
    staffNo: staff.staffNo,
    type: staff.type,
    firstName: staff.firstName,
    lastName: staff.lastName,
    gender: staff.gender,
    dateOfBirth: staff.dateOfBirth ? staff.dateOfBirth.toISOString().slice(0, 10) : null,
    address: staff.address,
    email: user.email,
    emailVerified: user.emailVerified,
    phone: user.phone,
    status: user.status,
    mustChangePassword: user.mustChangePassword,
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
    createdAt: user.createdAt.toISOString(),
  };
}
export type StaffView = ReturnType<typeof toView>;

function parseEmail(value: string): string {
  const email = normalizeEmail(value);
  if (!email) throw fail('email', 'Invalid email address');
  return email;
}
function parsePhone(value: string): string {
  const phone = normalizePhone(value);
  if (!phone) throw fail('phone', 'Invalid phone number');
  return phone;
}
function parseBirthDate(value: string): Date {
  const date = new Date(value);
  if (date > new Date()) throw fail('dateOfBirth', 'Cannot be in the future');
  return date;
}

export function createStaffService(deps: StaffServiceDeps) {
  const { users, staff: staffRepo, passwords, credentials, tokens, audit } = deps;

  const log = (type: StaffType, event: string, actor: Actor, ctx: Context, id: string, before: object | null, after: object | null) =>
    recordSafely(audit, {
      action: `${type}_${event}`,
      actorId: actor.id,
      entityType: 'user',
      entityId: id,
      ip: ctx.ip,
      requestId: ctx.requestId,
      before: before as Record<string, unknown> | null,
      after: after as Record<string, unknown> | null,
    });

  async function load(type: StaffType, userId: string) {
    const staff = await staffRepo.findByUserId(userId);
    if (!staff || staff.type !== type) throw new AppError('NOT_FOUND');
    const user = await users.findById(userId);
    if (!user) throw new AppError('NOT_FOUND');
    return { staff, user };
  }

  return {
    async list(type: StaffType, input: { page: number; limit: number; sort: StaffSort; q?: string | undefined }) {
      const { page, limit, sort, q } = input;
      const { items, total } = await staffRepo.list({ type, ...(q ? { q } : {}) }, { page, limit, sort });
      const found = new Map((await users.findManyByIds(items.map((s) => s.userId))).map((u) => [u.id, u]));
      return {
        total,
        items: items.flatMap((s) => {
          const u = found.get(s.userId);
          return u ? [toView(s, u)] : [];
        }),
      };
    },

    async get(type: StaffType, userId: string): Promise<StaffView> {
      const { staff, user } = await load(type, userId);
      return toView(staff, user);
    },

    async create(type: StaffType, input: CreateStaffInput, actor: Actor, ctx: Context) {
      const email = input.email !== undefined ? parseEmail(input.email) : undefined;
      const phone = input.phone !== undefined ? parsePhone(input.phone) : undefined;
      if (input.delivery === 'EMAIL_INVITE' && !email) {
        throw fail('email', 'An email address is required to send an invite');
      }
      const dateOfBirth = input.dateOfBirth !== undefined ? parseBirthDate(input.dateOfBirth) : undefined;

      const useTemporary = input.delivery === 'TEMPORARY_PASSWORD';
      const temporaryPassword = useTemporary ? passwords.generateTemporaryPassword() : null;
      const passwordHash = temporaryPassword ? await passwords.hashPassword(temporaryPassword) : undefined;

      const profile = {
        firstName: input.firstName,
        lastName: input.lastName,
        ...(input.gender ? { gender: input.gender } : {}),
        ...(dateOfBirth ? { dateOfBirth } : {}),
        ...(input.address ? { address: input.address } : {}),
      };

      // The login and the staff record are created together or not at all.
      const { user, staff } = await withTransaction(async (session) => {
        const created = await users.create(
          {
            ...(email ? { email } : {}),
            ...(phone ? { phone } : {}),
            ...(passwordHash ? { passwordHash } : {}),
            role: type === STAFF_TYPES.ADMIN ? ROLES.ADMIN : ROLES.TEACHER,
            status: useTemporary ? USER_STATUS.ACTIVE : USER_STATUS.INVITED,
            mustChangePassword: useTemporary,
          },
          new Date(),
          session,
        );
        const record = await staffRepo.create({ userId: created.id, type, profile }, session);
        return { user: created, staff: record };
      });

      const view = toView(staff, user);
      const inviteEmailSent =
        !useTemporary && email
          ? await credentials.issueInvite({ userId: user.id, email, name: input.firstName })
          : null;

      await log(type, 'CREATED', actor, ctx, user.id, null, view);
      return { account: view, temporaryPassword, inviteEmailSent };
    },

    async update(type: StaffType, userId: string, patch: UpdateStaffInput, actor: Actor, ctx: Context): Promise<StaffView> {
      if (Object.values(patch).every((v) => v === undefined)) throw fail('body', 'Nothing to update');
      const before = await load(type, userId);

      const email = patch.email !== undefined ? parseEmail(patch.email) : undefined;
      const phone = patch.phone !== undefined ? parsePhone(patch.phone) : undefined;
      const contact = {
        ...(email !== undefined && email !== before.user.email ? { email } : {}),
        ...(phone !== undefined && phone !== before.user.phone ? { phone } : {}),
      };
      const profile = {
        ...(patch.firstName !== undefined ? { firstName: patch.firstName } : {}),
        ...(patch.lastName !== undefined ? { lastName: patch.lastName } : {}),
        ...(patch.gender !== undefined ? { gender: patch.gender } : {}),
        ...(patch.dateOfBirth !== undefined ? { dateOfBirth: parseBirthDate(patch.dateOfBirth) } : {}),
        ...(patch.address !== undefined ? { address: patch.address } : {}),
      };

      await withTransaction(async (session) => {
        if (Object.keys(contact).length > 0 && !(await users.updateContact(userId, contact, session))) {
          throw new AppError('NOT_FOUND');
        }
        if (Object.keys(profile).length > 0) await staffRepo.updateProfile(userId, profile, session);
      });

      const after = await load(type, userId);
      const view = toView(after.staff, after.user);
      await log(type, 'UPDATED', actor, ctx, userId, toView(before.staff, before.user), view);
      return view;
    },

    /** Soft delete: the record stays for history, the person can no longer log in, and every login ends. */
    async remove(type: StaffType, userId: string, actor: Actor, ctx: Context): Promise<void> {
      const { staff, user } = await load(type, userId);
      const now = new Date();

      await withTransaction(async (session) => {
        await users.softDelete(userId, now, session);
        await staffRepo.softDelete(userId, now, session);
      });
      await tokens.revokeAllSessions(userId);

      await log(type, 'DELETED', actor, ctx, userId, toView(staff, user), null);
    },
  };
}

export type StaffService = ReturnType<typeof createStaffService>;