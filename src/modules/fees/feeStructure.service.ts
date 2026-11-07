import { AppError } from '../../common/errors/AppError';
import { isDuplicateKeyError } from '../../common/utils/mongoErrors';
import { isKobo, MAX_KOBO } from '../../common/utils/money';
import { sanitizeText } from '../../common/utils/text';
import { ROLES } from '../../config/constants';
import type { sessionRepository } from '../academics/session.repository';
import type { structureRepository } from '../academics/structure.repository';
import { recordSafely, type AuditPort } from '../audit/audit.port';
import type { NotificationService } from '../notifications/notification.service';
import type { userRepository } from '../users/user.repository';
import {
  FEE_STRUCTURE_STATUS, type FeeItem, type FeeStructureRecord, type FeeStructureStatus, type feeStructureRepository,
} from './feeStructure.repository';
import type { invoiceRepository } from './invoice.repository';

interface Actor { id: string }
interface Context { ip: string; requestId: string }

const fail = (field: string, issue: string): AppError => new AppError('VALIDATION_ERROR', { details: [{ field, issue }] });

function cleanItems(raw: { name: string; amountKobo: number }[]): { items: FeeItem[]; totalKobo: number } {
  const seen = new Set<string>();
  const items: FeeItem[] = [];
  let total = 0;
  raw.forEach((item, i) => {
    const name = sanitizeText(item.name);
    if (!name) throw fail(`items.${i}.name`, 'Required');
    if (seen.has(name.toLowerCase())) throw fail(`items.${i}.name`, 'Listed twice');
    seen.add(name.toLowerCase());
    if (!isKobo(item.amountKobo)) throw fail(`items.${i}.amountKobo`, 'Must be a whole number of kobo greater than zero');
    items.push({ name, amountKobo: item.amountKobo });
    total += item.amountKobo;
  });
  if (total > MAX_KOBO) throw fail('items', 'The total is too large');
  return { items, totalKobo: total };
}

export function createFeeStructureService(deps: {
  repo: typeof feeStructureRepository;
  invoices: Pick<typeof invoiceRepository, 'existsForStructure'>;
  sessions: Pick<typeof sessionRepository, 'findTerm'>;
  structure: Pick<typeof structureRepository, 'findClass' | 'classesByIds'>;
  users: Pick<typeof userRepository, 'findIdsByRoles'>;
  notifier: Pick<NotificationService, 'notify'>;
  audit: AuditPort;
}) {
  const { repo, invoices, sessions, structure, users, notifier, audit } = deps;

  const log = (action: string, actor: Actor, ctx: Context, id: string, metadata: Record<string, unknown>) =>
    recordSafely(audit, { action, actorId: actor.id, entityType: 'feeStructure', entityId: id, ip: ctx.ip, requestId: ctx.requestId, metadata });

  async function views(records: FeeStructureRecord[]) {
    const [classes, terms] = await Promise.all([
      structure.classesByIds(records.map((r) => r.classId)),
      Promise.all([...new Set(records.map((r) => r.termId))].map(async (id) => [id, (await sessions.findTerm(id))?.name ?? ''] as const)),
    ]);
    const termNames = new Map(terms);
    return records.map((r) => ({
      id: r.id, name: r.name, classId: r.classId, className: classes.get(r.classId)?.name ?? '', termId: r.termId,
      termName: termNames.get(r.termId) ?? '', sessionId: r.sessionId, items: r.items, totalKobo: r.totalKobo, status: r.status,
      approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null, createdAt: r.createdAt.toISOString(),
    }));
  }
  const viewOf = async (r: FeeStructureRecord) => {
    const [v] = await views([r]);
    if (!v) throw new Error('Fee structure view could not be built');
    return v;
  };

  async function mustFind(id: string): Promise<FeeStructureRecord> {
    const found = await repo.findById(id);
    if (!found) throw new AppError('NOT_FOUND');
    return found;
  }

  return {
    async list(input: { page: number; limit: number; termId?: string | undefined; classId?: string | undefined; status?: FeeStructureStatus | undefined }) {
      const { page, limit, ...filter } = input;
      const { items, total } = await repo.list(filter, { page, limit });
      return { items: await views(items), total };
    },

    async create(actor: Actor, input: { termId: string; classId: string; name: string; items: { name: string; amountKobo: number }[] }, ctx: Context) {
      const term = await sessions.findTerm(input.termId);
      if (!term) throw fail('termId', 'Term not found');
      if (term.locked) throw new AppError('CONFLICT', { message: 'This term is closed' });
      if (!(await structure.findClass(input.classId))) throw fail('classId', 'Class not found');
      const { items, totalKobo } = cleanItems(input.items);

      let created: FeeStructureRecord;
      try {
        created = await repo.create({ name: sanitizeText(input.name), classId: input.classId, termId: term.id, sessionId: term.sessionId, items, totalKobo, createdBy: actor.id });
      } catch (err) {
        if (isDuplicateKeyError(err)) throw new AppError('CONFLICT', { message: 'This class already has a fee structure for this term', cause: err });
        throw err;
      }

      await notifier.notify({
        userIds: await users.findIdsByRoles([ROLES.SUPER_ADMIN]), type: 'FEE_STRUCTURE_PENDING', title: 'A fee structure needs your approval',
        body: `"${created.name}" is waiting for approval.`, data: { feeStructureId: created.id }, email: false,
      });
      await log('FEE_STRUCTURE_CREATED', actor, ctx, created.id, { name: created.name, totalKobo });
      return viewOf(created);
    },

    /** Drafts only. An approved structure is frozen, because invoices copy its amounts. */
    async update(actor: Actor, id: string, patch: { name?: string | undefined; items?: { name: string; amountKobo: number }[] | undefined }, ctx: Context) {
      if (patch.name === undefined && patch.items === undefined) throw fail('body', 'Nothing to update');
      const before = await mustFind(id);
      if (before.status !== FEE_STRUCTURE_STATUS.DRAFT) throw new AppError('CONFLICT', { message: 'An approved fee structure is frozen. Ask the super admin to revoke the approval first.' });

      const cleaned = patch.items ? cleanItems(patch.items) : null;
      const updated = await repo.updateDraft(id, {
        ...(patch.name !== undefined ? { name: sanitizeText(patch.name) } : {}),
        ...(cleaned ? { items: cleaned.items, totalKobo: cleaned.totalKobo } : {}),
      });
      if (!updated) throw new AppError('CONFLICT', { message: 'This fee structure was just approved. Reload it.' });
      await log('FEE_STRUCTURE_UPDATED', actor, ctx, id, { before: { totalKobo: before.totalKobo }, after: { totalKobo: updated.totalKobo } });
      return viewOf(updated);
    },

    async approve(actor: Actor, id: string, ctx: Context) {
      const existing = await mustFind(id);
      const updated = await repo.transition(id, FEE_STRUCTURE_STATUS.DRAFT, FEE_STRUCTURE_STATUS.APPROVED, { by: actor.id, at: new Date() });
      if (!updated) {
        if (existing.status === FEE_STRUCTURE_STATUS.APPROVED) return viewOf(existing);
        throw new AppError('CONFLICT');
      }
      await notifier.notify({
        userIds: [...new Set([existing.createdBy, ...(await users.findIdsByRoles([ROLES.ADMIN]))])], type: 'FEE_STRUCTURE_APPROVED',
        title: 'A fee structure was approved', body: `"${updated.name}" can now be used to generate invoices.`, data: { feeStructureId: id }, email: false,
      });
      await log('FEE_STRUCTURE_APPROVED', actor, ctx, id, { totalKobo: updated.totalKobo });
      return viewOf(updated);
    },

    /** The escape hatch for a mistake, allowed only while no invoice has been made from it. */
    async revokeApproval(actor: Actor, id: string, ctx: Context) {
      await mustFind(id);
      if (await invoices.existsForStructure(id)) throw new AppError('CONFLICT', { message: 'Invoices have already been generated from this fee structure, so it cannot be reopened.' });
      const updated = await repo.transition(id, FEE_STRUCTURE_STATUS.APPROVED, FEE_STRUCTURE_STATUS.DRAFT, null);
      if (!updated) throw new AppError('CONFLICT', { message: 'This fee structure is not approved' });
      await log('FEE_STRUCTURE_APPROVAL_REVOKED', actor, ctx, id, {});
      return viewOf(updated);
    },
  };
}

export type FeeStructureService = ReturnType<typeof createFeeStructureService>;