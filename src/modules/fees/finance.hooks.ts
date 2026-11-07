import { AppError } from '../../common/errors/AppError';
import { isDuplicateKeyError } from '../../common/utils/mongoErrors';
import { formatNaira, isKobo } from '../../common/utils/money';
import { logger } from '../../common/utils/logger';
import { ROLES } from '../../config/constants';
import { withTransaction } from '../../config/db';
import { recordSafely, type AuditPort } from '../audit/audit.port';
import type { NotificationService } from '../notifications/notification.service';
import type { RequestChecks } from '../requests/request.checks';
import type { RequestDecidedEvent, RequestEvents } from '../requests/request.events';
import type { ReportGate } from '../results/studentResults.service';
import type { SchoolPolicy } from '../settings/settings.repository';
import type { linkRepository } from '../users/link.repository';
import type { userRepository } from '../users/user.repository';
import type { invoiceRepository } from './invoice.repository';
import type { LedgerService } from './ledger.service';
import { PAYMENT_STATUS, type PaymentRecord, type paymentRepository } from './payment.repository';

const bad = (field: string, issue: string): AppError => new AppError('VALIDATION_ERROR', { details: [{ field: `payload.${field}`, issue }] });
const naira = (kobo: number): string => `NGN ${formatNaira(kobo)}`;

export function registerFinanceHooks(deps: {
  events: RequestEvents;
  checks: RequestChecks;
  invoices: Pick<typeof invoiceRepository, 'findById'>;
  payments: Pick<typeof paymentRepository, 'findById' | 'addRefund'>;
  ledger: LedgerService;
  links: Pick<typeof linkRepository, 'activeParentIdsOf'>;
  users: Pick<typeof userRepository, 'findIdsByRoles'>;
  notifier: Pick<NotificationService, 'notify'>;
  audit: AuditPort;
  startOnlineRefund: (event: RequestDecidedEvent, payment: PaymentRecord) => Promise<void>;
  reservedRefunds: (paymentId: string) => Promise<number>;
}): void {
  const { events, checks, invoices, payments, ledger, links, users, notifier, audit,startOnlineRefund, reservedRefunds } = deps;

  // ---- rules at request time (create, update, submit and just before a decision)
  checks.register('FEE_WAIVER', async ({ payload, studentId }) => {
    const invoice = await invoices.findById(String(payload.invoiceId));
    if (!invoice || invoice.studentId !== studentId) throw bad('invoiceId', 'This invoice does not belong to the student');
    if (!isKobo(payload.amountKobo)) throw bad('amountKobo', 'Must be a whole number of kobo greater than zero');
    if (invoice.balanceKobo <= 0) throw bad('invoiceId', 'This invoice has nothing left to pay');
    if (payload.amountKobo > invoice.balanceKobo) throw bad('amountKobo', `More than the outstanding balance of ${naira(invoice.balanceKobo)}`);
  });

  checks.register('REFUND', async ({ payload, studentId }) => {
    const payment = await payments.findById(String(payload.paymentId));
    if (!payment || payment.studentId !== studentId) throw bad('paymentId', 'This payment does not belong to the student');
    if (payment.status !== PAYMENT_STATUS.SUCCESS) throw bad('paymentId', 'Only a successful payment can be refunded');
    if (!isKobo(payload.amountKobo)) throw bad('amountKobo', 'Must be a whole number of kobo greater than zero');
    const refundable = payment.amountKobo - payment.refundedKobo - (await reservedRefunds(payment.id));
    if (payload.amountKobo > refundable) throw bad('amountKobo', `More than the refundable amount of ${naira(refundable)}`);
  });

  /** If a decision cannot be applied, nothing is written, and the people who need to act are told. */
  async function couldNotApply(event: RequestDecidedEvent, why: string): Promise<void> {
    await notifier.notify({
      userIds: [...new Set([event.createdBy, ...(await users.findIdsByRoles([ROLES.SUPER_ADMIN]))])], type: 'LEDGER_APPLY_FAILED',
      title: 'An approved request could not be applied', body: `${event.reference}: ${why}`, data: { requestId: event.requestId }, email: true,
    });
    await recordSafely(audit, { action: 'LEDGER_APPLY_FAILED', actorId: event.decidedBy, entityType: 'request', entityId: event.requestId, metadata: { type: event.type, why } });
  }

  // ---- what an approval does
  events.onDecided(async (event) => {
    if (event.outcome !== 'APPROVED' || (event.type !== 'FEE_WAIVER' && event.type !== 'REFUND')) return;
    const amount = event.payload.amountKobo;
    const reason = typeof event.payload.reason === 'string' ? event.payload.reason : null;
    if (!isKobo(amount)) return couldNotApply(event, 'The amount is not valid');

    try {
      if (event.type === 'FEE_WAIVER') {
        const invoice = await invoices.findById(String(event.payload.invoiceId));
        if (!invoice || invoice.studentId !== event.studentId) return couldNotApply(event, 'The invoice no longer matches the student');

        await withTransaction((session) =>
          ledger.post({ invoiceId: invoice.id, studentId: invoice.studentId, type: 'WAIVER', amountKobo: -amount, requestId: event.requestId, note: reason, createdBy: event.decidedBy }, 'NO_OVERPAY', session),
        );
        await notifier.notify({
          userIds: await links.activeParentIdsOf([invoice.studentId]), type: 'FEE_WAIVED', title: 'A fee waiver was applied',
          body: `${naira(amount)} was waived on invoice ${invoice.number}.`, data: { invoiceId: invoice.id }, email: true,
        });
        await recordSafely(audit, { action: 'FEE_WAIVER_APPLIED', actorId: event.decidedBy, entityType: 'invoice', entityId: invoice.id, metadata: { requestId: event.requestId, amountKobo: amount } });
        return;
      }

      const payment = await payments.findById(String(event.payload.paymentId));
      if (!payment || payment.studentId !== event.studentId) return couldNotApply(event, 'The payment no longer matches the student');
            if (payment.method === 'ONLINE') {
        await startOnlineRefund(event, payment); // asks Paystack. The ledger changes only when Paystack confirms.
        return;
      }

      await withTransaction(async (session) => {
        if (!(await payments.addRefund(payment.id, payment.refundedKobo, amount, session))) {
          throw new AppError('CONFLICT', { message: 'The payment changed while the refund was being applied' });
        }
        await ledger.post(
          { invoiceId: payment.invoiceId, studentId: payment.studentId, type: 'REFUND', amountKobo: amount, requestId: event.requestId, refPaymentId: payment.id, note: reason, createdBy: event.decidedBy },
          'ANY', session,
        );
      });
      await notifier.notify({
        userIds: await links.activeParentIdsOf([payment.studentId]), type: 'REFUND_APPLIED', title: 'A refund was recorded',
        body: `${naira(amount)} was refunded on receipt ${payment.receiptNo ?? ''}.`, data: { paymentId: payment.id }, email: true,
      });
      await recordSafely(audit, { action: 'REFUND_APPLIED', actorId: event.decidedBy, entityType: 'payment', entityId: payment.id, metadata: { requestId: event.requestId, amountKobo: amount } });
    } catch (err) {
      if (isDuplicateKeyError(err)) return; // this decision was already applied
      logger.error({ err, requestId: event.requestId }, 'could not apply a finance decision');
      await couldNotApply(event, err instanceof AppError ? err.message : 'An unexpected error occurred');
    }
  });
}

/** Parents and students see "withheld" instead of the report card while fees are owed, if the school turned that on. */
export function createReportGate(deps: {
  invoices: Pick<typeof invoiceRepository, 'outstandingForStudent'>;
  settings: { getPolicy(): Promise<SchoolPolicy> };
}): ReportGate {
  return {
    async isWithheld(studentId, termId) {
      if (!(await deps.settings.getPolicy()).withholdReportsIfOwing) return false;
      return (await deps.invoices.outstandingForStudent(studentId, termId)) > 0;
    },
  };
}