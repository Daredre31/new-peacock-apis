import { createHash } from 'node:crypto';
import { AppError } from '../../common/errors/AppError';
import type { ScopeService } from '../../common/scope/scope.service';
import { addDays, daysBetween, isIsoDate, schoolToday } from '../../common/utils/dates';
import { formatNaira, isKobo } from '../../common/utils/money';
import { sanitizeText } from '../../common/utils/text';
import { ROLES, type Role } from '../../config/constants';
import { withTransaction } from '../../config/db';
import type { sessionRepository } from '../academics/session.repository';
import type { structureRepository } from '../academics/structure.repository';
import { recordSafely, type AuditPort } from '../audit/audit.port';
import type { NotificationService } from '../notifications/notification.service';
import type { SettingsService } from '../settings/settings.service';
import type { linkRepository } from '../users/link.repository';
import type { staffRepository } from '../users/staff.repository';
import type { studentRepository } from '../users/student.repository';
import { INVOICE_STATUS, type invoiceRepository } from './invoice.repository';
import type { LedgerService } from './ledger.service';
import {
  PAYMENT_STATUS, type OfflineMethod, type PaymentFilter, type PaymentMethod, type PaymentRecord, type PaymentStatus, type paymentRepository,
} from './payment.repository';
import { renderReceipt } from './receipt.pdf';

interface Actor { id: string; role: Role }
interface Context { ip: string; requestId: string }

export interface OfflinePaymentInput {
  invoiceId: string; amountKobo: number; method: OfflineMethod; externalReference?: string | undefined;
  paidOn?: string | undefined; note?: string | undefined;
}

const MAX_BACKDATE_DAYS = 90;
const fail = (field: string, issue: string): AppError => new AppError('VALIDATION_ERROR', { details: [{ field, issue }] });
const naira = (kobo: number): string => `NGN ${formatNaira(kobo)}`;

function duplicateField(err: unknown): string | null {
  if (typeof err === 'object' && err !== null && 'keyPattern' in err && typeof err.keyPattern === 'object' && err.keyPattern !== null) {
    return Object.keys(err.keyPattern)[0] ?? null;
  }
  return null;
}

export function createPaymentService(deps: {
  payments: typeof paymentRepository;
  invoices: Pick<typeof invoiceRepository, 'findById' | 'findManyByIds'>;
  ledger: LedgerService;
  sessions: Pick<typeof sessionRepository, 'findTerm'>;
  structure: Pick<typeof structureRepository, 'armsByIds' | 'classesByIds'>;
  students: Pick<typeof studentRepository, 'profileMap'>;
  staff: Pick<typeof staffRepository, 'nameMap'>;
  links: Pick<typeof linkRepository, 'activeParentIdsOf' | 'activeStudentIdsOf'>;
  scope: Pick<ScopeService, 'assertCanAccessStudent'>;
  settings: Pick<SettingsService, 'getProfile'>;
  notifier: Pick<NotificationService, 'notify'>;
  audit: AuditPort;
}) {
  const { payments, invoices, ledger, sessions, structure, students, staff, links, scope, settings, notifier, audit } = deps;

  const log = (action: string, actor: Actor, ctx: Context, id: string, metadata: Record<string, unknown>) =>
    recordSafely(audit, { action, actorId: actor.id, entityType: 'payment', entityId: id, ip: ctx.ip, requestId: ctx.requestId, metadata });

  async function views(records: PaymentRecord[]) {
    const [inv, profiles, recorders] = await Promise.all([
      invoices.findManyByIds(records.map((p) => p.invoiceId)), students.profileMap(records.map((p) => p.studentId)),
      staff.nameMap(records.flatMap((p) => (p.recordedBy ? [p.recordedBy] : []))),
    ]);
    return records.map((p) => ({
      id: p.id, reference: p.reference, receiptNo: p.receiptNo, invoiceId: p.invoiceId, invoiceNumber: inv.get(p.invoiceId)?.number ?? '',
      studentId: p.studentId, studentName: profiles.get(p.studentId)?.name ?? '', method: p.method, status: p.status,
      amountKobo: p.amountKobo, feeKobo: p.feeKobo, totalChargeKobo: p.totalChargeKobo, refundedKobo: p.refundedKobo,
      externalReference: p.externalReference, paidAt: p.paidAt ? p.paidAt.toISOString() : null, balanceAfterKobo: p.balanceAfterKobo,
      recordedBy: p.recordedBy ? { id: p.recordedBy, name: recorders.get(p.recordedBy) ?? '' } : null,
      reverseReason: p.reverseReason, createdAt: p.createdAt.toISOString(),
    }));
  }
  const viewOf = async (p: PaymentRecord) => {
    const [v] = await views([p]);
    if (!v) throw new Error('Payment view could not be built');
    return v;
  };

  async function parentsOf(studentId: string): Promise<string[]> {
    return links.activeParentIdsOf([studentId]);
  }

  async function mustAccess(actor: Actor, id: string): Promise<PaymentRecord> {
    const payment = await payments.findById(id);
    if (!payment) throw new AppError('NOT_FOUND');
    if (actor.role === ROLES.PARENT) await scope.assertCanAccessStudent(actor, payment.studentId); // someone else's child is a 404
    return payment;
  }

  return {
    /**
     * Cash, bank transfer or POS received at the school. It is posted straight to the books and a receipt is issued.
     * The Idempotency-Key makes a double click safe, and a bank reference can only be recorded once.
     */
    async recordOffline(actor: Actor, input: OfflinePaymentInput, idemKey: string, ctx: Context) {
      if (!isKobo(input.amountKobo)) throw fail('amountKobo', 'Must be a whole number of kobo greater than zero');
      const externalReference = input.externalReference ? sanitizeText(input.externalReference).toUpperCase() : undefined;
      if (externalReference && !/^[A-Z0-9][A-Z0-9/_.-]{3,63}$/.test(externalReference)) throw fail('externalReference', 'Use 4 to 64 letters, digits or / _ . -');
      if (input.method !== 'CASH' && !externalReference) throw fail('externalReference', 'Required for transfers and POS: enter the bank or slip reference');

      const today = schoolToday();
      const paidOn = input.paidOn ?? today;
      if (!isIsoDate(paidOn)) throw fail('paidOn', 'Use the format YYYY-MM-DD');
      if (paidOn > today) throw fail('paidOn', 'Cannot be in the future');
      if (daysBetween(paidOn, today) > MAX_BACKDATE_DAYS) throw fail('paidOn', `Cannot be more than ${MAX_BACKDATE_DAYS} days ago`);

      const hash = createHash('sha256').update([input.invoiceId, input.amountKobo, input.method, externalReference ?? '', paidOn].join('|')).digest('hex');
      const replay = await payments.findByIdempotency(actor.id, idemKey);
      if (replay) {
        if (replay.idemHash !== hash) throw new AppError('CONFLICT', { message: 'This Idempotency-Key was already used for a different payment' });
        return viewOf(replay); // the same request again: return what was already recorded
      }

      const invoice = await invoices.findById(input.invoiceId);
      if (!invoice) throw new AppError('NOT_FOUND');
      if (invoice.balanceKobo <= 0 || invoice.status === INVOICE_STATUS.PAID) throw new AppError('FEE_ALREADY_PAID');
      if (input.amountKobo > invoice.balanceKobo) throw new AppError('PAYMENT_AMOUNT_INVALID', { message: `The amount is more than the outstanding balance of ${naira(invoice.balanceKobo)}` });

      const id = payments.newId();
      const note = input.note ? sanitizeText(input.note) || null : null;
      let result: { payment: PaymentRecord; balanceKobo: number };
      try {
        result = await withTransaction(async (session) => {
          const posted = await ledger.post(
            { invoiceId: invoice.id, studentId: invoice.studentId, type: 'PAYMENT', amountKobo: -input.amountKobo, paymentId: id, note, createdBy: actor.id },
            'NO_OVERPAY', session,
          );
          const payment = await payments.createOffline(
            {
              id, invoiceId: invoice.id, studentId: invoice.studentId, recordedBy: actor.id, method: input.method, amountKobo: input.amountKobo,
              ...(externalReference ? { externalReference } : {}), paidAt: new Date(`${paidOn}T12:00:00Z`), balanceAfterKobo: posted.invoice.balanceKobo,
              note, idemScope: actor.id, idemKey, idemHash: hash,
            },
            session,
          );
          return { payment, balanceKobo: posted.invoice.balanceKobo };
        });
      } catch (err) {
        const field = duplicateField(err);
        if (field === 'externalReference') throw new AppError('CONFLICT', { message: 'This bank or slip reference has already been recorded', cause: err });
        if (field === 'idemKey' || field === 'idemScope') {
          const raced = await payments.findByIdempotency(actor.id, idemKey);
          if (raced) return viewOf(raced);
        }
        throw err;
      }

      await notifier.notify({
        userIds: await parentsOf(invoice.studentId), type: 'PAYMENT_RECEIVED', title: 'Payment received',
        body: `${naira(input.amountKobo)} was received. Receipt ${result.payment.receiptNo ?? ''}. ${result.balanceKobo > 0 ? `Balance: ${naira(result.balanceKobo)}.` : 'The invoice is fully paid.'}`,
        data: { paymentId: id }, email: true,
      });
      await log('PAYMENT_RECORDED_OFFLINE', actor, ctx, id, { invoiceId: invoice.id, method: input.method, amountKobo: input.amountKobo, receiptNo: result.payment.receiptNo, externalReference: externalReference ?? null });
      return viewOf(result.payment);
    },

    async list(actor: Actor, input: { page: number; limit: number; invoiceId?: string | undefined; studentId?: string | undefined; status?: PaymentStatus | undefined; method?: PaymentMethod | undefined; from?: string | undefined; to?: string | undefined }) {
      const filter: PaymentFilter = { invoiceId: input.invoiceId, studentId: input.studentId, status: input.status, method: input.method, from: input.from ? new Date(input.from) : undefined, to: input.to ? new Date(input.to) : undefined };
      if (actor.role === ROLES.PARENT) {
        if (input.studentId) await scope.assertCanAccessStudent(actor, input.studentId);
        filter.studentIds = await links.activeStudentIdsOf(actor.id);
      }
      const { items, total } = await payments.list(filter, { page: input.page, limit: input.limit });
      return { items: await views(items), total };
    },

    async get(actor: Actor, id: string) {
      return viewOf(await mustAccess(actor, id));
    },

    /** The super admin undoes an offline payment by a reversing entry. The original entry stays, and the receipt is marked reversed. */
    async reverse(actor: Actor, id: string, input: { reason: string }, ctx: Context) {
      const reason = sanitizeText(input.reason);
      if (!reason) throw fail('reason', 'A reason is required');
      const payment = await payments.findById(id);
      if (!payment) throw new AppError('NOT_FOUND');
      if (payment.method === 'ONLINE') throw new AppError('CONFLICT', { message: 'Online payments are refunded through a refund request, not reversed' });
      if (payment.status !== PAYMENT_STATUS.SUCCESS) throw new AppError('CONFLICT', { message: 'Only a successful payment can be reversed' });
      if (payment.refundedKobo > 0) throw new AppError('CONFLICT', { message: 'Part of this payment was already refunded' });

      const updated = await withTransaction(async (session) => {
        const marked = await payments.markReversed(id, actor.id, reason, new Date(), session);
        if (!marked) throw new AppError('CONFLICT', { message: 'This payment was just changed. Reload it.' });
        await ledger.post(
          { invoiceId: payment.invoiceId, studentId: payment.studentId, type: 'PAYMENT_REVERSAL', amountKobo: payment.amountKobo, paymentId: id, note: reason, createdBy: actor.id },
          'ANY', session,
        );
        return marked;
      });

      await notifier.notify({
        userIds: await parentsOf(payment.studentId), type: 'PAYMENT_REVERSED', title: 'A payment record was reversed',
        body: `Receipt ${payment.receiptNo ?? ''} (${naira(payment.amountKobo)}) was reversed by the school. Please contact the school office.`, data: { paymentId: id }, email: true,
      });
      await log('PAYMENT_REVERSED', actor, ctx, id, { amountKobo: payment.amountKobo, reason });
      return viewOf(updated);
    },

    /** Built on request from the stored payment, so it can never differ from the books. */
    async receipt(actor: Actor, id: string): Promise<{ filename: string; buffer: Buffer }> {
      const payment = await mustAccess(actor, id);
      if (payment.status !== PAYMENT_STATUS.SUCCESS && payment.status !== PAYMENT_STATUS.REVERSED) throw new AppError('CONFLICT', { message: 'A receipt exists only for a successful payment' });
      const invoice = await invoices.findById(payment.invoiceId);
      if (!invoice || !payment.receiptNo) throw new AppError('NOT_FOUND');

      const [school, profiles, arms, term, recorders] = await Promise.all([
        settings.getProfile(), students.profileMap([payment.studentId]), structure.armsByIds([invoice.classArmId]),
        sessions.findTerm(invoice.termId), payment.recordedBy ? staff.nameMap([payment.recordedBy]) : Promise.resolve(new Map<string, string>()),
      ]);
      const arm = arms.get(invoice.classArmId);
      const classes = arm ? await structure.classesByIds([arm.classId]) : new Map();
      const profile = profiles.get(payment.studentId);

      const buffer = await renderReceipt({
        school: { name: school.name, address: school.address, phone: school.phone, email: school.email },
        receiptNo: payment.receiptNo, date: schoolToday((payment.paidAt ?? payment.createdAt).getTime()),
        studentName: profile?.name ?? '', admissionNo: profile?.admissionNo ?? '',
        className: arm ? `${(classes.get(arm.classId) as { name: string } | undefined)?.name ?? ''} ${arm.name}`.trim() : '',
        termName: term?.name ?? '', invoiceNumber: invoice.number, items: invoice.items, method: payment.method,
        reference: payment.reference, externalReference: payment.externalReference, amountKobo: payment.amountKobo, feeKobo: payment.feeKobo,
        totalPaidKobo: payment.totalChargeKobo, balanceAfterKobo: payment.balanceAfterKobo,
        receivedBy: payment.recordedBy ? (recorders.get(payment.recordedBy) ?? null) : null, reversed: payment.status === PAYMENT_STATUS.REVERSED,
      });
      return { filename: `receipt-${payment.receiptNo}.pdf`, buffer };
    },
  };
}

export type PaymentService = ReturnType<typeof createPaymentService>;
// void addDays;