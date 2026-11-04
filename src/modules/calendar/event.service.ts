import { AppError } from '../../common/errors/AppError';
import { sanitizeText } from '../../common/utils/text';
import { ROLES, type Role } from '../../config/constants';
import type { structureRepository } from '../academics/structure.repository';
import type { Audience } from '../announcements/announcement.repository';
import { recordSafely, type AuditPort } from '../audit/audit.port';
import type { EventRecord, eventRepository } from './event.repository';

interface Actor { id: string; role: Role }
interface Context { ip: string; requestId: string }
export interface EventInput { title: string; description?: string | null | undefined; startsAt: string; endsAt: string; audience: Audience }

const fail = (field: string, issue: string): AppError => new AppError('VALIDATION_ERROR', { details: [{ field, issue }] });
const MAX_SPAN_MS = 31 * 86_400_000;

const view = (e: EventRecord) => ({
  id: e.id, title: e.title, description: e.description, startsAt: e.startsAt.toISOString(), endsAt: e.endsAt.toISOString(),
  audience: e.audience, createdAt: e.createdAt.toISOString(),
});
export type EventView = ReturnType<typeof view>;

export function createEventService(deps: {
  repo: typeof eventRepository;
  structure: Pick<typeof structureRepository, 'armsByIds'>;
  armIdsOfUser: (actor: Actor) => Promise<string[]>;
  audit: AuditPort;
}) {
  const { repo, structure, audit } = deps;
  const isStaff = (role: Role): boolean => role === ROLES.SUPER_ADMIN || role === ROLES.ADMIN;

  async function checkAudience(audience: Audience): Promise<void> {
    if (audience.type !== 'CLASS_ARMS') return;
    const found = await structure.armsByIds(audience.classArmIds);
    if (found.size !== new Set(audience.classArmIds).size) throw fail('audience.classArmIds', 'One or more class arms do not exist');
  }

  const log = (action: string, actor: Actor, ctx: Context, id: string, metadata: Record<string, unknown>) =>
    recordSafely(audit, { action, actorId: actor.id, entityType: 'event', entityId: id, ip: ctx.ip, requestId: ctx.requestId, metadata });

  return {
    async create(actor: Actor, input: EventInput, ctx: Context): Promise<EventView> {
      const startsAt = new Date(input.startsAt);
      const endsAt = new Date(input.endsAt);
      if (endsAt < startsAt) throw fail('endsAt', 'Must not be before the start');
      if (endsAt.getTime() - startsAt.getTime() > MAX_SPAN_MS) throw fail('endsAt', 'An event cannot be longer than 31 days');
      await checkAudience(input.audience);

      const created = await repo.create({
        title: sanitizeText(input.title), description: input.description ? sanitizeText(input.description) || null : null,
        startsAt, endsAt, audience: input.audience, createdBy: actor.id,
      });
      await log('EVENT_CREATED', actor, ctx, created.id, { title: created.title });
      return view(created);
    },

    async update(actor: Actor, id: string, patch: Partial<EventInput>, ctx: Context): Promise<EventView> {
      if (Object.values(patch).every((v) => v === undefined)) throw fail('body', 'Nothing to update');
      const before = await repo.findById(id);
      if (!before) throw new AppError('NOT_FOUND');

      const startsAt = patch.startsAt ? new Date(patch.startsAt) : before.startsAt;
      const endsAt = patch.endsAt ? new Date(patch.endsAt) : before.endsAt;
      if (endsAt < startsAt) throw fail('endsAt', 'Must not be before the start');
      if (endsAt.getTime() - startsAt.getTime() > MAX_SPAN_MS) throw fail('endsAt', 'An event cannot be longer than 31 days');
      if (patch.audience) await checkAudience(patch.audience);

      const updated = await repo.update(id, {
        ...(patch.title !== undefined ? { title: sanitizeText(patch.title) } : {}),
        ...(patch.description !== undefined ? { description: patch.description ? sanitizeText(patch.description) || null : null } : {}),
        startsAt, endsAt, ...(patch.audience ? { audience: patch.audience } : {}),
      });
      if (!updated) throw new AppError('NOT_FOUND');
      await log('EVENT_UPDATED', actor, ctx, id, { title: updated.title });
      return view(updated);
    },

    async remove(actor: Actor, id: string, ctx: Context): Promise<void> {
      const event = await repo.findById(id);
      if (!event || !(await repo.remove(id))) throw new AppError('NOT_FOUND');
      await log('EVENT_DELETED', actor, ctx, id, { title: event.title });
    },

    async list(actor: Actor, range: { from: Date; to: Date }, o: { page: number; limit: number }) {
      const viewer = { role: actor.role, armIds: isStaff(actor.role) ? [] : await deps.armIdsOfUser(actor) };
      const { items, total } = await repo.listVisible(viewer, range, o);
      return { items: items.map(view), total };
    },
  };
}

export type EventService = ReturnType<typeof createEventService>;