import { AppError } from '../../common/errors/AppError';
import { sanitizeText } from '../../common/utils/text';
import { ANNOUNCEMENT_POLICY, ROLES, type Role } from '../../config/constants';
import type { structureRepository } from '../academics/structure.repository';
import { recordSafely, type AuditPort } from '../audit/audit.port';
import type { NotificationService } from '../notifications/notification.service';
import type { staffRepository } from '../users/staff.repository';
import type { userRepository } from '../users/user.repository';
import {
  ANNOUNCEMENT_STATUS, type Audience, type AnnouncementRecord, type AnnouncementStatus, type announcementRepository,
} from './announcement.repository';

interface Actor { id: string; role: Role }
interface Context { ip: string; requestId: string }

export interface AnnouncementServiceDeps {
  repo: typeof announcementRepository;
  structure: Pick<typeof structureRepository, 'armsByIds'>;
  staff: Pick<typeof staffRepository, 'nameMap'>;
  users: Pick<typeof userRepository, 'findIdsByRoles'>;
  notifier: Pick<NotificationService, 'notify'>;
  armIdsOfUser: (actor: Actor) => Promise<string[]>;
  audit: AuditPort;
  teacherPostsNeedApproval?: () => Promise<boolean>;
}

export interface AnnouncementInput {
  title: string;
  body: string;
  audience: Audience;
  publishAt?: string | undefined;
  expiresAt?: string | null | undefined;
  pinned?: boolean | undefined;
}

const fail = (field: string, issue: string): AppError => new AppError('VALIDATION_ERROR', { details: [{ field, issue }] });
const isStaffRole = (role: Role): boolean => role === ROLES.SUPER_ADMIN || role === ROLES.ADMIN;

export function createAnnouncementService(deps: AnnouncementServiceDeps) {
  const { repo, structure, staff, users, notifier, audit } = deps;

    const needsApprovalFor = async (actor: Actor): Promise<boolean> =>
    actor.role === ROLES.TEACHER &&
    (deps.teacherPostsNeedApproval ? await deps.teacherPostsNeedApproval() : ANNOUNCEMENT_POLICY.teacherPostsNeedApproval);

  const log = (action: string, actor: Actor, ctx: Context, id: string, before: object | null, after: object | null) =>
    recordSafely(audit, {
      action, actorId: actor.id, entityType: 'announcement', entityId: id, ip: ctx.ip, requestId: ctx.requestId,
      before: before as Record<string, unknown> | null, after: after as Record<string, unknown> | null,
    });

  async function viewsOf(records: AnnouncementRecord[], readerId: string | null) {
    const [authors, read] = await Promise.all([
      staff.nameMap(records.map((r) => r.authorId)),
      readerId ? repo.readSet(readerId, records.map((r) => r.id)) : Promise.resolve(new Set<string>()),
    ]);
    return records.map((r) => ({
      id: r.id, title: r.title, body: r.body, audience: r.audience,
      publishAt: r.publishAt.toISOString(), expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
      pinned: r.pinned, status: r.status, authorId: r.authorId, authorRole: r.authorRole,
      authorName: authors.get(r.authorId) ?? (r.authorRole === ROLES.SUPER_ADMIN ? 'Proprietor' : null),
      read: readerId ? read.has(r.id) : null,
      createdAt: r.createdAt.toISOString(),
    }));
  }
  const viewOf = async (record: AnnouncementRecord, readerId: string | null) => {
    const [view] = await viewsOf([record], readerId);
    if (!view) throw new Error('Announcement view could not be built');
    return view;
  };

  async function checkAudience(actor: Actor, audience: Audience): Promise<void> {
    if (audience.type === 'CLASS_ARMS') {
      const found = await structure.armsByIds(audience.classArmIds);
      if (found.size !== new Set(audience.classArmIds).size) throw fail('audience.classArmIds', 'One or more class arms do not exist');
    }
    if (actor.role === ROLES.TEACHER) {
      const own = new Set(await deps.armIdsOfUser(actor));
      if (audience.type !== 'CLASS_ARMS' || audience.classArmIds.some((id) => !own.has(id))) {
        throw new AppError('FORBIDDEN', { message: 'Teachers can only post to classes they teach' });
      }
    }
  }

  function parseDates(input: { publishAt?: string | undefined; expiresAt?: string | null | undefined }, now: Date, current?: AnnouncementRecord) {
    const publishAt = input.publishAt ? new Date(input.publishAt) : (current?.publishAt ?? now);
    const expiresAt = input.expiresAt === undefined ? (current?.expiresAt ?? null) : input.expiresAt === null ? null : new Date(input.expiresAt);
    if (expiresAt && expiresAt <= publishAt) throw fail('expiresAt', 'Must be after the publish time');
    if (expiresAt && expiresAt <= now) throw fail('expiresAt', 'Must be in the future');
    return { publishAt, expiresAt };
  }

  async function mustFind(id: string): Promise<AnnouncementRecord> {
    const record = await repo.findById(id);
    if (!record) throw new AppError('NOT_FOUND');
    return record;
  }

  /** Authors can change their own. Admins and the super admin can change any. Everyone else sees nothing. */
  function assertCanManage(actor: Actor, record: AnnouncementRecord): void {
    if (!isStaffRole(actor.role) && record.authorId !== actor.id) throw new AppError('NOT_FOUND');
  }

  async function tellAdminsPending(record: AnnouncementRecord): Promise<void> {
    await notifier.notify({
      userIds: await users.findIdsByRoles([ROLES.ADMIN]),
      type: 'ANNOUNCEMENT_PENDING', title: 'An announcement needs approval', body: `"${record.title}" is waiting for your approval.`,
      data: { announcementId: record.id }, email: false,
    });
  }

  return {
    async create(actor: Actor, input: AnnouncementInput, ctx: Context) {
      const now = new Date();
      const audience = input.audience;
      await checkAudience(actor, audience);
      if (input.pinned && !isStaffRole(actor.role)) throw new AppError('FORBIDDEN', { message: 'Only admins can pin announcements' });
      const dates = parseDates(input, now);

      const needsApproval = await needsApprovalFor(actor)
      const created = await repo.create({
        authorId: actor.id, authorRole: actor.role, title: sanitizeText(input.title), body: sanitizeText(input.body), audience,
        publishAt: dates.publishAt, expiresAt: dates.expiresAt, pinned: input.pinned ?? false,
        status: needsApproval ? ANNOUNCEMENT_STATUS.PENDING_APPROVAL : ANNOUNCEMENT_STATUS.APPROVED,
      });

      if (needsApproval) await tellAdminsPending(created);
      const view = await viewOf(created, null);
      await log('ANNOUNCEMENT_CREATED', actor, ctx, created.id, null, { title: view.title, status: view.status, audience: view.audience });
      return view;
    },

    async update(actor: Actor, id: string, patch: Partial<AnnouncementInput>, ctx: Context) {
      if (Object.values(patch).every((v) => v === undefined)) throw fail('body', 'Nothing to update');
      const before = await mustFind(id);
      assertCanManage(actor, before);

      if (patch.audience) await checkAudience(actor, patch.audience);
      if (patch.pinned !== undefined && !isStaffRole(actor.role)) throw new AppError('FORBIDDEN', { message: 'Only admins can pin announcements' });
      const dates = parseDates({ publishAt: patch.publishAt, expiresAt: patch.expiresAt }, new Date(), before);

      // A teacher's edit sends the post back for approval, because the content changed.
         const status: AnnouncementStatus | undefined = (await needsApprovalFor(actor)) ? ANNOUNCEMENT_STATUS.PENDING_APPROVAL : undefined;
      const updated = await repo.update(id, {
        ...(patch.title !== undefined ? { title: sanitizeText(patch.title) } : {}),
        ...(patch.body !== undefined ? { body: sanitizeText(patch.body) } : {}),
        ...(patch.audience ? { audience: patch.audience } : {}),
        ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
        ...dates,
        ...(status ? { status } : {}),
      });
      if (!updated) throw new AppError('NOT_FOUND');

      if (status && before.status === ANNOUNCEMENT_STATUS.APPROVED) await tellAdminsPending(updated);
      const view = await viewOf(updated, null);
      await log('ANNOUNCEMENT_UPDATED', actor, ctx, id, { title: before.title, status: before.status }, { title: view.title, status: view.status });
      return view;
    },

    async remove(actor: Actor, id: string, ctx: Context): Promise<void> {
      const record = await mustFind(id);
      assertCanManage(actor, record);
      await repo.remove(id);
      await log('ANNOUNCEMENT_DELETED', actor, ctx, id, { title: record.title }, null);
    },

    /** An admin approves a teacher's post. Approving twice is harmless. */
    async approve(actor: Actor, id: string, ctx: Context) {
      const record = await mustFind(id);
      if (record.status === ANNOUNCEMENT_STATUS.APPROVED) return viewOf(record, null);

      const approved = await repo.approve(id, actor.id, new Date());
      if (!approved) return viewOf(await mustFind(id), null);

      await notifier.notify({
        userIds: [record.authorId], type: 'ANNOUNCEMENT_APPROVED', title: 'Your announcement was approved',
        body: `"${record.title}" is now published.`, data: { announcementId: id }, email: false,
      });
      await log('ANNOUNCEMENT_APPROVED', actor, ctx, id, { status: record.status }, { status: approved.status });
      return viewOf(approved, null);
    },

    /** feed: what you can read, with unread markers. manage: what you wrote (everything, for admins). */
    async list(actor: Actor, input: { page: number; limit: number; scope: 'feed' | 'manage'; status?: AnnouncementStatus | undefined; q?: string | undefined }) {
      if (input.scope === 'manage') {
        if (actor.role === ROLES.PARENT || actor.role === ROLES.STUDENT) throw new AppError('FORBIDDEN');
        const { items, total } = await repo.manage(
          { authorId: isStaffRole(actor.role) ? undefined : actor.id, status: input.status, q: input.q },
          { page: input.page, limit: input.limit },
        );
        return { items: await viewsOf(items, null), total };
      }

      const viewer = { role: actor.role, armIds: isStaffRole(actor.role) ? [] : await deps.armIdsOfUser(actor) };
      const { items, total } = await repo.feed(viewer, new Date(), { page: input.page, limit: input.limit });
      return { items: await viewsOf(items, actor.id), total };
    },

    async markRead(actor: Actor, id: string): Promise<{ read: true }> {
      const viewer = { role: actor.role, armIds: isStaffRole(actor.role) ? [] : await deps.armIdsOfUser(actor) };
      if (!(await repo.findVisible(id, viewer, new Date()))) throw new AppError('NOT_FOUND');
      await repo.markRead(actor.id, id, new Date());
      return { read: true };
    },

    async unreadCount(actor: Actor): Promise<{ unread: number }> {
      const viewer = { role: actor.role, armIds: isStaffRole(actor.role) ? [] : await deps.armIdsOfUser(actor) };
      return { unread: await repo.unreadCount(actor.id, viewer, new Date()) };
    },
  };
}

export type AnnouncementService = ReturnType<typeof createAnnouncementService>;