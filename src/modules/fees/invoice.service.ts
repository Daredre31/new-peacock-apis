import { AppError } from '../../common/errors/AppError';
import type { ScopeService } from '../../common/scope/scope.service';
import { addDays, isIsoDate, schoolToday } from '../../common/utils/dates';
import { isDuplicateKeyError } from '../../common/utils/mongoErrors';
import { logger } from '../../common/utils/logger';
import { ROLES, type Role } from '../../config/constants';
import { withTransaction } from '../../config/db';
import type { enrolmentRepository } from '../academics/enrolment.repository';
import type { sessionRepository } from '../academics/session.repository';
import type { structureRepository } from '../academics/structure.repository';
import { recordSafely, type AuditPort } from '../audit/audit.port';
import type { NotificationService } from '../notifications/notification.service';
import type { linkRepository } from '../users/link.repository';
import type { studentRepository } from '../users/student.repository';
import type { feeStructureRepository } from './feeStructure.repository';
import { INVOICE_STATUS, type InvoiceFilter, type InvoiceRecord, type InvoiceSort, type InvoiceStatus, type invoiceRepository } from './invoice.repository';
import type { ledgerRepository } from './ledger.repository';
import type { paymentRepository } from './payment.repository';

interface Actor { id: string; role: Role }
interface Context { ip: string; requestId: string }

const fail = (field: string, issue: string): AppError => new AppError('VALIDATION_ERROR', { details: [{ field, issue }] });
const MAX_STUDENTS_PER_RUN = 5000;

export function createInvoiceService(deps: {
  invoices: typeof invoiceRepository;
  structures: Pick<typeof feeStructureRepository, 'findApproved'>;
  ledger: typeof ledgerRepository;
  payments: Pick<typeof paymentRepository, 'listForInvoices'>;
  sessions: Pick<typeof sessionRepository, 'findTerm'>;
  structure: Pick<typeof structureRepository, 'findClass' | 'listArms' | 'armsByIds' | 'classesByIds'>;
  enrolments: Pick<typeof enrolmentRepository, 'listForSession'>;
  students: Pick<typeof studentRepository, 'findManyByUserIds' | 'profileMap'>;
  links: Pick<typeof linkRepository, 'activeParentIdsOf' | 'activeStudentIdsOf'>;
  scope: Pick<ScopeService, 'assertCanAccessStudent'>;
  notifier: Pick<NotificationService, 'notify'>;
  audit: AuditPort;
}) {
  const { invoices, structures, ledger, payments, sessions, structure, enrolments, students, links, scope, notifier, audit } = deps;

  async function termNames(ids: string[]): Promise<Map<string, string>> {
    const found = await Promise.all([...new Set(ids)].map(async (id) => [id, (await sessions.findTerm(id))?.name ?? ''] as const));
    return new Map(found);
  }

  async function views(records: InvoiceRecord[]) {
    const [profiles, arms, terms] = await Promise.all([
      students.profileMap(records.map((r) => r.studentId)), structure.armsByIds(records.map((r) => r.classArmId)), termNames(records.map((r) => r.termId)),
    ]);
    const classes = await structure.classesByIds([...arms.values()].map((a) => a.classId));
    const today = schoolToday();
    return records.map((r) => {
      const arm = arms.get(r.classArmId);
      return {
        id: r.id, number: r.number, studentId: r.studentId, studentName: profiles.get(r.studentId)?.name ?? '', admissionNo: profiles.get(r.studentId)?.admissionNo ?? '',
        classArmId: r.classArmId, classArmName: arm ? `${classes.get(arm.classId)?.name ?? ''} ${arm.name}`.trim() : '',
        termId: r.termId, termName: terms.get(r.termId) ?? '', items: r.items, totalKobo: r.totalKobo,
        paidKobo: r.totalKobo - r.balanceKobo, balanceKobo: r.balanceKobo, creditKobo: r.balanceKobo < 0 ? -r.balanceKobo : 0,
        status: r.status, dueDate: r.dueDate, overdue: r.balanceKobo > 0 && r.dueDate < today, createdAt: r.createdAt.toISOString(),
      };
    });
  }

  return {
    /**
     * Makes an invoice for every active student enrolled in the class this session. Safe to run again:
     * students who already have one are skipped, so new joiners get theirs and nobody is billed twice.
     */
    async generate(actor: Actor, input: { classId: string; termId: string; dueDate: string }, ctx: Context) {
      const term = await sessions.findTerm(input.termId);
      if (!term) throw fail('termId', 'Term not found');
      if (term.locked) throw new AppError('CONFLICT', { message: 'This term is closed' });
      if (!(await structure.findClass(input.classId))) throw fail('classId', 'Class not found');
      if (!isIsoDate(input.dueDate)) throw fail('dueDate', 'Use the format YYYY-MM-DD');
      if (input.dueDate < addDays(schoolToday(), -30)) throw fail('dueDate', 'Cannot be more than 30 days in the past');

      const feeStructure = await structures.findApproved(term.id, input.classId);
      if (!feeStructure) throw new AppError('CONFLICT', { message: 'There is no approved fee structure for this class and term' });

      const { items: arms } = await structure.listArms({ classId: input.classId }, { page: 1, limit: 500, sort: 'name' });
      const placed = (await Promise.all(arms.map((a) => enrolments.listForSession(term.sessionId, a.id, MAX_STUDENTS_PER_RUN)))).flat();
      const active = new Set((await students.findManyByUserIds(placed.map((p) => p.studentId))).filter((s) => s.status === 'ACTIVE').map((s) => s.userId));
      const targets = placed.filter((p) => active.has(p.studentId));

      let created = 0;
      let skipped = 0;
      let failed = 0;
      const billed: string[] = [];

      for (const target of targets) {
        try {
          // The invoice and its first ledger entry are written together or not at all.
          await withTransaction(async (session) => {
            const invoice = await invoices.create(
              { studentId: target.studentId, classId: input.classId, classArmId: target.classArmId, sessionId: term.sessionId, termId: term.id, feeStructureId: feeStructure.id, items: feeStructure.items, totalKobo: feeStructure.totalKobo, dueDate: input.dueDate, createdBy: actor.id },
              session,
            );
            await ledger.insert({ invoiceId: invoice.id, studentId: target.studentId, type: 'INVOICE', amountKobo: feeStructure.totalKobo, note: feeStructure.name, createdBy: actor.id }, session);
          });
          created += 1;
          billed.push(target.studentId);
        } catch (err) {
          if (isDuplicateKeyError(err)) skipped += 1;
          else { failed += 1; logger.error({ err, studentId: target.studentId }, 'invoice generation failed for a student'); }
        }
      }

      if (billed.length > 0) {
        await notifier.notify({
          userIds: await links.activeParentIdsOf(billed), type: 'INVOICE_ISSUED', title: 'School fees invoice',
          body: `${term.name} fees are now available. Due ${input.dueDate}.`, data: { termId: term.id }, email: false,
        });
      }
      await recordSafely(audit, {
        action: 'INVOICES_GENERATED', actorId: actor.id, entityType: 'feeStructure', entityId: feeStructure.id, ip: ctx.ip, requestId: ctx.requestId,
        metadata: { classId: input.classId, termId: term.id, created, skipped, failed, totalKobo: feeStructure.totalKobo },
      });
      return { students: targets.length, created, skipped, failed, totalKobo: feeStructure.totalKobo };
    },

    async list(input: { page: number; limit: number; sort: InvoiceSort; termId?: string | undefined; classArmId?: string | undefined; status?: InvoiceStatus | undefined; studentId?: string | undefined; overdue?: boolean | undefined; q?: string | undefined }) {
      const { page, limit, sort, overdue, ...rest } = input;
      const filter: InvoiceFilter = { ...rest, ...(overdue ? { overdueBefore: schoolToday() } : {}) };
      const { items, total } = await invoices.list(filter, { page, limit, sort });
      return { items: await views(items), total };
    },

    /** The full picture of one invoice: items, every ledger entry, every payment, and a check that the balance adds up. */
    async get(id: string) {
      const invoice = await invoices.findById(id);
      if (!invoice) throw new AppError('NOT_FOUND');
      const [[view], entries, paid] = await Promise.all([views([invoice]), ledger.listForInvoice(id), payments.listForInvoices([id])]);
      const ledgerSum = entries.reduce((sum, e) => sum + e.amountKobo, 0);
      return {
        ...view,
        ledger: entries.map((e) => ({ id: e.id, type: e.type, amountKobo: e.amountKobo, note: e.note, paymentId: e.paymentId, requestId: e.requestId, createdAt: e.createdAt.toISOString() })),
        payments: paid.map((p) => ({ id: p.id, method: p.method, status: p.status, amountKobo: p.amountKobo, feeKobo: p.feeKobo, receiptNo: p.receiptNo, paidAt: p.paidAt ? p.paidAt.toISOString() : null })),
        ledgerBalanceKobo: ledgerSum, consistent: ledgerSum === invoice.balanceKobo,
      };
    },

    /** A parent's view of a linked child's invoices, with payments but without the ledger internals. */
    async forChild(actor: Actor, studentId: string, input: { page: number; limit: number; termId?: string | undefined }) {
      await scope.assertCanAccessStudent(actor, studentId); // out of scope is a 404
      const { items, total } = await invoices.list({ studentId, termId: input.termId }, { page: input.page, limit: input.limit, sort: '-createdAt' });
      const [rows, paid] = await Promise.all([views(items), payments.listForInvoices(items.map((i) => i.id))]);
      return {
        total,
        items: rows.map((v) => ({
          ...v,
          payments: paid.filter((p) => p.invoiceId === v.id).map((p) => ({ id: p.id, method: p.method, status: p.status, amountKobo: p.amountKobo, feeKobo: p.feeKobo, receiptNo: p.receiptNo, paidAt: p.paidAt ? p.paidAt.toISOString() : null })),
        })),
      };
    },

    async childIds(actor: Actor): Promise<string[]> {
      return actor.role === ROLES.PARENT ? links.activeStudentIdsOf(actor.id) : [];
    },
  };
}

export type InvoiceService = ReturnType<typeof createInvoiceService>;
