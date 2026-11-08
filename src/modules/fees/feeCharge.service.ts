import { AppError } from '../../common/errors/AppError';
import { addDays, isIsoDate, schoolToday } from '../../common/utils/dates';
import { isDuplicateKeyError } from '../../common/utils/mongoErrors';
import { logger } from '../../common/utils/logger';
import { isKobo, MAX_KOBO } from '../../common/utils/money';
import { sanitizeText } from '../../common/utils/text';
import { ROLES } from '../../config/constants';
import { withTransaction } from '../../config/db';
import type { enrolmentRepository } from '../academics/enrolment.repository';
import type { sessionRepository } from '../academics/session.repository';
import type { structureRepository } from '../academics/structure.repository';
import { recordSafely, type AuditPort } from '../audit/audit.port';
import type { NotificationService } from '../notifications/notification.service';
import type { linkRepository } from '../users/link.repository';
import type { studentRepository } from '../users/student.repository';
import type { userRepository } from '../users/user.repository';
import {
  FEE_CHARGE_STATUS, type Audience, type FeeChargeRecord, type FeeChargeStatus, type feeChargeRepository,
} from './feeCharge.repository';
import type { FeeItem } from './feeStructure.repository';
import type { invoiceRepository } from './invoice.repository';
import type { ledgerRepository } from './ledger.repository';

interface Actor { id: string }
interface Context { ip: string; requestId: string }

const fail = (field: string, issue: string): AppError => new AppError('VALIDATION_ERROR', { details: [{ field, issue }] });
const MAX_STUDENTS_PER_RUN = 5000;
const MAX_PICKED_STUDENTS = 200;

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

function checkDueDate(dueDate: string): void {
  if (!isIsoDate(dueDate)) throw fail('dueDate', 'Use the format YYYY-MM-DD');
  if (dueDate < addDays(schoolToday(), -30)) throw fail('dueDate', 'Cannot be more than 30 days in the past');
}

export function createFeeChargeService(deps: {
  repo: typeof feeChargeRepository;
  invoices: Pick<typeof invoiceRepository, 'create' | 'existsForStructure' | 'countForStructure'>;
  ledger: Pick<typeof ledgerRepository, 'insert'>;
  sessions: Pick<typeof sessionRepository, 'findTerm'>;
  structure: Pick<typeof structureRepository, 'findClass' | 'findArm' | 'listArms' | 'armsByIds' | 'classesByIds'>;
  enrolments: Pick<typeof enrolmentRepository, 'listForSession' | 'forStudents'>;
  students: Pick<typeof studentRepository, 'findManyByUserIds' | 'profileMap'>;
  links: Pick<typeof linkRepository, 'activeParentIdsOf'>;
  users: Pick<typeof userRepository, 'findIdsByRoles'>;
  notifier: Pick<NotificationService, 'notify'>;
  audit: AuditPort;
}) {
  const { repo, invoices, ledger, sessions, structure, enrolments, students, links, users, notifier, audit } = deps;

  const log = (action: string, actor: Actor, ctx: Context, id: string, metadata: Record<string, unknown>) =>
    recordSafely(audit, { action, actorId: actor.id, entityType: 'feeCharge', entityId: id, ip: ctx.ip, requestId: ctx.requestId, metadata });

  async function checkAudience(audience: Audience): Promise<Audience> {
    if (audience.kind === 'CLASS') {
      if (!(await structure.findClass(audience.classId))) throw fail('audience.classId', 'Class not found');
      return audience;
    }
    if (audience.kind === 'ARM') {
      if (!(await structure.findArm(audience.classArmId))) throw fail('audience.classArmId', 'Class arm not found');
      return audience;
    }
    const ids = [...new Set(audience.studentIds)];
    if (ids.length === 0 || ids.length > MAX_PICKED_STUDENTS) throw fail('audience.studentIds', `Pick 1 to ${MAX_PICKED_STUDENTS} students`);
    const found = await students.findManyByUserIds(ids);
    if (found.length !== ids.length) throw fail('audience.studentIds', 'One or more students were not found');
    return { kind: 'STUDENTS', studentIds: ids };
  }

  async function views(records: FeeChargeRecord[]) {
    const termNames = new Map(
      await Promise.all([...new Set(records.map((r) => r.termId))].map(async (id) => [id, (await sessions.findTerm(id))?.name ?? ''] as const)),
    );
    const classIds = records.flatMap((r) => (r.audience.kind === 'CLASS' ? [r.audience.classId] : []));
    const armIds = records.flatMap((r) => (r.audience.kind === 'ARM' ? [r.audience.classArmId] : []));
    const arms = await structure.armsByIds(armIds);
    const classes = await structure.classesByIds([...classIds, ...[...arms.values()].map((a) => a.classId)]);
    const counts = new Map(await Promise.all(records.map(async (r) => [r.id, await invoices.countForStructure(r.id)] as const)));
    return records.map((r) => {
      const a = r.audience;
      const arm = a.kind === 'ARM' ? arms.get(a.classArmId) : undefined;
      const audience =
        a.kind === 'CLASS' ? { kind: a.kind, classId: a.classId, classArmId: null, studentIds: [] as string[], label: classes.get(a.classId)?.name ?? '' }
        : a.kind === 'ARM' ? { kind: a.kind, classId: null, classArmId: a.classArmId, studentIds: [] as string[], label: arm ? `${classes.get(arm.classId)?.name ?? ''} ${arm.name}`.trim() : '' }
        : { kind: a.kind, classId: null, classArmId: null, studentIds: a.studentIds, label: `${a.studentIds.length} selected student${a.studentIds.length === 1 ? '' : 's'}` };
      return {
        id: r.id, title: r.title, termId: r.termId, termName: termNames.get(r.termId) ?? '', items: r.items, totalKobo: r.totalKobo,
        dueDate: r.dueDate, blocksReports: r.blocksReports, audience, status: r.status,
        approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null, issuedAt: r.issuedAt ? r.issuedAt.toISOString() : null,
        invoicesIssued: counts.get(r.id) ?? 0, createdAt: r.createdAt.toISOString(),
      };
    });
  }
  const viewOf = async (r: FeeChargeRecord) => {
    const [v] = await views([r]);
    if (!v) throw new Error('Fee charge view could not be built');
    return v;
  };

  async function mustFind(id: string): Promise<FeeChargeRecord> {
    const found = await repo.findById(id);
    if (!found) throw new AppError('NOT_FOUND');
    return found;
  }

  /** Everyone who should be billed, each with the arm they sit in this session. */
  async function targetsOf(charge: FeeChargeRecord, sessionId: string): Promise<{ targets: { studentId: string; classArmId: string }[]; notEnrolled: number }> {
    const a = charge.audience;
    let placed: { studentId: string; classArmId: string }[];
    let notEnrolled = 0;
    if (a.kind === 'CLASS') {
      const { items: arms } = await structure.listArms({ classId: a.classId }, { page: 1, limit: 500, sort: 'name' });
      placed = (await Promise.all(arms.map((arm) => enrolments.listForSession(sessionId, arm.id, MAX_STUDENTS_PER_RUN)))).flat();
    } else if (a.kind === 'ARM') {
      placed = await enrolments.listForSession(sessionId, a.classArmId, MAX_STUDENTS_PER_RUN);
    } else {
      const map = await enrolments.forStudents(a.studentIds, sessionId);
      placed = a.studentIds.flatMap((id) => {
        const e = map.get(id);
        return e ? [{ studentId: id, classArmId: e.classArmId }] : [];
      });
      notEnrolled = a.studentIds.length - placed.length;
    }
    const active = new Set((await students.findManyByUserIds(placed.map((p) => p.studentId))).filter((s) => s.status === 'ACTIVE').map((s) => s.userId));
    return { targets: placed.filter((p) => active.has(p.studentId)), notEnrolled };
  }

  return {
    async list(input: { page: number; limit: number; termId?: string | undefined; status?: FeeChargeStatus | undefined }) {
      const { page, limit, ...filter } = input;
      const { items, total } = await repo.list(filter, { page, limit });
      return { items: await views(items), total };
    },

    async get(id: string) {
      return viewOf(await mustFind(id));
    },

    async create(
      actor: Actor,
      input: { termId: string; title: string; items: { name: string; amountKobo: number }[]; dueDate: string; blocksReports: boolean; audience: Audience },
      ctx: Context,
    ) {
      const term = await sessions.findTerm(input.termId);
      if (!term) throw fail('termId', 'Term not found');
      if (term.locked) throw new AppError('CONFLICT', { message: 'This term is closed' });
      checkDueDate(input.dueDate);
      const { items, totalKobo } = cleanItems(input.items);
      const audience = await checkAudience(input.audience);

      const created = await repo.create({
        title: sanitizeText(input.title), termId: term.id, sessionId: term.sessionId, items, totalKobo, dueDate: input.dueDate,
        blocksReports: input.blocksReports, audience, createdBy: actor.id,
      });
      await notifier.notify({
        userIds: await users.findIdsByRoles([ROLES.SUPER_ADMIN]), type: 'FEE_CHARGE_PENDING', title: 'An extra charge needs your approval',
        body: `"${created.title}" is waiting for approval.`, data: { feeChargeId: created.id }, email: false,
      });
      await log('FEE_CHARGE_CREATED', actor, ctx, created.id, { title: created.title, totalKobo, audience: audience.kind });
      return viewOf(created);
    },

    /** Drafts only: once approved, a charge is frozen. */
    async update(
      actor: Actor, id: string,
      patch: { title?: string | undefined; items?: { name: string; amountKobo: number }[] | undefined; dueDate?: string | undefined; blocksReports?: boolean | undefined; audience?: Audience | undefined },
      ctx: Context,
    ) {
      if (Object.values(patch).every((v) => v === undefined)) throw fail('body', 'Nothing to update');
      const before = await mustFind(id);
      if (before.status !== FEE_CHARGE_STATUS.DRAFT) throw new AppError('CONFLICT', { message: 'An approved charge is frozen. Ask the super admin to reopen it, or create a new one.' });
      if (patch.dueDate !== undefined) checkDueDate(patch.dueDate);
      const cleaned = patch.items ? cleanItems(patch.items) : null;
      const audience = patch.audience ? await checkAudience(patch.audience) : undefined;

      const updated = await repo.updateDraft(id, {
        ...(patch.title !== undefined ? { title: sanitizeText(patch.title) } : {}),
        ...(cleaned ? { items: cleaned.items, totalKobo: cleaned.totalKobo } : {}),
        ...(patch.dueDate !== undefined ? { dueDate: patch.dueDate } : {}),
        ...(patch.blocksReports !== undefined ? { blocksReports: patch.blocksReports } : {}),
        ...(audience ? { audience } : {}),
      });
      if (!updated) throw new AppError('CONFLICT', { message: 'This charge was just approved. Reload it.' });
      await log('FEE_CHARGE_UPDATED', actor, ctx, id, { before: { totalKobo: before.totalKobo }, after: { totalKobo: updated.totalKobo } });
      return viewOf(updated);
    },

    async remove(actor: Actor, id: string, ctx: Context): Promise<void> {
      const before = await mustFind(id);
      if (!(await repo.deleteDraft(id))) throw new AppError('CONFLICT', { message: 'Only a draft can be deleted' });
      await log('FEE_CHARGE_DELETED', actor, ctx, id, { title: before.title });
    },

    async approve(actor: Actor, id: string, ctx: Context) {
      const existing = await mustFind(id);
      const updated = await repo.transition(id, FEE_CHARGE_STATUS.DRAFT, FEE_CHARGE_STATUS.APPROVED, { by: actor.id, at: new Date() });
      if (!updated) {
        if (existing.status === FEE_CHARGE_STATUS.APPROVED) return viewOf(existing);
        throw new AppError('CONFLICT');
      }
      await notifier.notify({
        userIds: [...new Set([existing.createdBy, ...(await users.findIdsByRoles([ROLES.ADMIN]))])], type: 'FEE_CHARGE_APPROVED',
        title: 'An extra charge was approved', body: `"${updated.title}" can now be issued as invoices.`, data: { feeChargeId: id }, email: false,
      });
      await log('FEE_CHARGE_APPROVED', actor, ctx, id, { totalKobo: updated.totalKobo });
      return viewOf(updated);
    },

    /** The escape hatch for a mistake, allowed only while nothing has been issued. */
    async revokeApproval(actor: Actor, id: string, ctx: Context) {
      const existing = await mustFind(id);
      if (existing.issuedAt || (await invoices.existsForStructure(id))) throw new AppError('CONFLICT', { message: 'Invoices were already issued from this charge, so it cannot be reopened.' });
      const updated = await repo.transition(id, FEE_CHARGE_STATUS.APPROVED, FEE_CHARGE_STATUS.DRAFT, null);
      if (!updated) throw new AppError('CONFLICT', { message: 'This charge is not approved' });
      await log('FEE_CHARGE_APPROVAL_REVOKED', actor, ctx, id, {});
      return viewOf(updated);
    },

    /**
     * Makes one invoice per student for an approved charge. Safe to run again: students who already
     * have it are skipped, so a student who joins the class later can still be billed.
     */
    async issue(actor: Actor, id: string, ctx: Context) {
      const charge = await mustFind(id);
      if (charge.status !== FEE_CHARGE_STATUS.APPROVED) throw new AppError('CONFLICT', { message: 'The super admin must approve this charge before it can be issued' });
      const term = await sessions.findTerm(charge.termId);
      if (!term) throw new AppError('NOT_FOUND');
      if (term.locked) throw new AppError('CONFLICT', { message: 'This term is closed' });
      if (charge.dueDate < addDays(schoolToday(), -30)) throw fail('dueDate', 'The due date is too far in the past. Create a new charge with a later date.');

      const { targets, notEnrolled } = await targetsOf(charge, term.sessionId);
      const arms = await structure.armsByIds(targets.map((t) => t.classArmId));

      let created = 0;
      let skipped = 0;
      let failed = 0;
      const billed: string[] = [];
      for (const target of targets) {
        const arm = arms.get(target.classArmId);
        if (!arm) { failed += 1; continue; }
        try {
          // The invoice and its first ledger entry are written together or not at all.
          await withTransaction(async (session) => {
            const invoice = await invoices.create(
              {
                studentId: target.studentId, classId: arm.classId, classArmId: target.classArmId, sessionId: term.sessionId, termId: term.id,
                feeStructureId: charge.id, items: charge.items, totalKobo: charge.totalKobo, dueDate: charge.dueDate, createdBy: actor.id,
                title: charge.title, blocksReports: charge.blocksReports,
              },
              session,
            );
            await ledger.insert({ invoiceId: invoice.id, studentId: target.studentId, type: 'INVOICE', amountKobo: charge.totalKobo, note: charge.title, createdBy: actor.id }, session);
          });
          created += 1;
          billed.push(target.studentId);
        } catch (err) {
          if (isDuplicateKeyError(err)) skipped += 1;
          else { failed += 1; logger.error({ err, studentId: target.studentId }, 'extra charge invoice failed for a student'); }
        }
      }

      if (created + skipped > 0) await repo.markIssued(charge.id, new Date());
      if (billed.length > 0) {
        await notifier.notify({
          userIds: await links.activeParentIdsOf(billed), type: 'INVOICE_ISSUED', title: `New charge: ${charge.title}`,
          body: `An additional charge for ${term.name} is now available. Due ${charge.dueDate}.`, data: { termId: term.id, feeChargeId: charge.id }, email: false,
        });
      }
      await log('FEE_CHARGE_ISSUED', actor, ctx, charge.id, { created, skipped, failed, notEnrolled, totalKobo: charge.totalKobo });
      return { students: targets.length, created, skipped, failed, notEnrolled, totalKobo: charge.totalKobo };
    },
  };
}

export type FeeChargeService = ReturnType<typeof createFeeChargeService>;
