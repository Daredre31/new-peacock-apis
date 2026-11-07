import { isDuplicateKeyError } from '../../common/utils/mongoErrors';
import { formatNaira } from '../../common/utils/money';
import { ROLES } from '../../config/constants';
import { withTransaction } from '../../config/db';
import type { PaystackClient } from '../../integrations/paystack';
import { recordSafely, type AuditPort } from '../audit/audit.port';
import type { NotificationService } from '../notifications/notification.service';
import type { linkRepository } from '../users/link.repository';
import type { userRepository } from '../users/user.repository';
import type { LedgerService } from './ledger.service';
import { PAYMENT_STATUS, type PaymentRecord, type paymentRepository } from './payment.repository';

export type ConfirmSource = 'WEBHOOK' | 'POLL' | 'RECHECK' | 'SWEEP' | 'RECONCILE';
export type ConfirmOutcome = 'CONFIRMED' | 'ALREADY' | 'NOT_PAID_YET' | 'FAILED' | 'MISMATCH' | 'NEEDS_REVIEW' | 'UNAVAILABLE' | 'UNKNOWN';
export interface ConfirmResult { outcome: ConfirmOutcome; payment: PaymentRecord | null }

const naira = (kobo: number): string => `NGN ${formatNaira(kobo)}`;

export function createConfirmationService(deps: {
  payments: typeof paymentRepository;
  paystack: Pick<PaystackClient, 'verify'>;
  ledger: LedgerService;
  links: Pick<typeof linkRepository, 'activeParentIdsOf'>;
  users: Pick<typeof userRepository, 'findIdsByRoles'>;
  notifier: Pick<NotificationService, 'notify'>;
  audit: AuditPort;
}) {
  const { payments, paystack, ledger, links, users, notifier, audit } = deps;

  async function alertStaff(title: string, body: string, data: Record<string, string>): Promise<void> {
    await notifier.notify({ userIds: await users.findIdsByRoles([ROLES.SUPER_ADMIN, ROLES.ADMIN]), type: 'PAYMENT_ALERT', title, body, data, email: true });
  }

  async function flagMismatch(payment: PaymentRecord, reason: string, source: ConfirmSource): Promise<ConfirmResult> {
    const flagged = await payments.markNeedsReview(payment.id, reason, null);
    await alertStaff('A payment needs review', `Payment ${payment.reference}: ${reason}. Nothing was credited.`, { paymentId: payment.id });
    await recordSafely(audit, { action: 'PAYMENT_MISMATCH', entityType: 'payment', entityId: payment.id, metadata: { reason, source, expectedKobo: payment.totalChargeKobo } });
    return { outcome: 'MISMATCH', payment: flagged ?? payment };
  }

  /**
   * Asks Paystack what really happened, and credits the invoice only if everything matches.
   * Safe to call any number of times, from anywhere, at the same time.
   */
  async function confirm(reference: string, options: { source: ConfirmSource; minGapMs?: number }): Promise<ConfirmResult> {
    const payment = await payments.findByReference(reference);
    if (!payment || payment.method !== 'ONLINE') return { outcome: 'UNKNOWN', payment: null };
    if (payment.status === PAYMENT_STATUS.SUCCESS || payment.status === PAYMENT_STATUS.REVERSED) return { outcome: 'ALREADY', payment };
    if (payment.status === PAYMENT_STATUS.NEEDS_REVIEW) return { outcome: 'NEEDS_REVIEW', payment };

    // Polling and the recheck button are throttled, so users can never hammer Paystack.
    if (options.minGapMs !== undefined && !(await payments.claimVerify(payment.id, options.minGapMs, new Date()))) {
      return { outcome: 'NOT_PAID_YET', payment };
    }

    const verified = await paystack.verify(payment.reference);
    if (!verified.ok) return { outcome: verified.kind === 'NOT_FOUND' ? 'NOT_PAID_YET' : 'UNAVAILABLE', payment };
    const tx = verified.data;

    if (tx.reference !== payment.reference) return flagMismatch(payment, 'Paystack answered about a different transaction', options.source);

    if (tx.status === 'failed' || tx.status === 'reversed') {
      const failed = await payments.markFailed(payment.id, tx.gateway_response ?? tx.status, tx.status);
      if (failed && failed.payerId) {
        await notifier.notify({ userIds: [failed.payerId], type: 'PAYMENT_FAILED', title: 'Your payment did not go through', body: `${naira(failed.totalChargeKobo)} was not charged. You can try again from the fees page.`, data: { paymentId: failed.id }, email: false });
      }
      return { outcome: 'FAILED', payment: failed ?? payment };
    }
    // abandoned, ongoing, pending and anything we do not recognise all mean: not paid yet.
    if (tx.status !== 'success') return { outcome: 'NOT_PAID_YET', payment };

    // Paystack says paid. The amount and currency must match exactly what we asked for.
    if (!Number.isSafeInteger(tx.amount) || tx.amount !== payment.totalChargeKobo || tx.currency !== 'NGN') {
      return flagMismatch(payment, `Expected NGN ${formatNaira(payment.totalChargeKobo)} but Paystack reports ${Number.isSafeInteger(tx.amount) ? formatNaira(tx.amount) : 'an invalid amount'} ${tx.currency}`, options.source);
    }

    let balanceKobo = 0;
    try {
      const credited = await withTransaction(async (session) => {
        const paidAt = tx.paid_at ? new Date(tx.paid_at) : new Date();
        const claimed = await payments.claimSuccess(payment.id, { transactionId: String(tx.id), paidAt: Number.isNaN(paidAt.getTime()) ? new Date() : paidAt }, session);
        if (!claimed) return false; // another confirmation got there first
        // Credit what the invoice is owed. The online fee is recorded on the payment and is not part of the invoice.
        const posted = await ledger.post(
          { invoiceId: payment.invoiceId, studentId: payment.studentId, type: 'PAYMENT', amountKobo: -payment.amountKobo, paymentId: payment.id, note: null, createdBy: null },
          'ANY', session,
        );
        await payments.setBalanceAfter(payment.id, posted.invoice.balanceKobo, session);
        balanceKobo = posted.invoice.balanceKobo;
        return true;
      });
      if (!credited) return { outcome: 'ALREADY', payment: (await payments.findById(payment.id)) ?? payment };
    } catch (err) {
      // The unique index on (payment, type) refused a second credit: it was already credited.
      if (isDuplicateKeyError(err)) return { outcome: 'ALREADY', payment: (await payments.findById(payment.id)) ?? payment };
      throw err;
    }

    const fresh = (await payments.findById(payment.id)) ?? payment;
    if (payment.payerId) {
      await notifier.notify({
        userIds: [payment.payerId], type: 'PAYMENT_CONFIRMED', title: 'Payment received',
        body: `${naira(payment.totalChargeKobo)} was received (${naira(payment.amountKobo)} for fees and ${naira(payment.feeKobo)} online fee). Receipt ${fresh.receiptNo ?? ''}.`,
        data: { paymentId: payment.id }, email: true,
      });
    }
    const others = (await links.activeParentIdsOf([payment.studentId])).filter((id) => id !== payment.payerId);
    await notifier.notify({ userIds: others, type: 'PAYMENT_CONFIRMED', title: 'A fee payment was made', body: `${naira(payment.amountKobo)} was paid towards your child's fees.`, data: { paymentId: payment.id }, email: false });
    if (balanceKobo < 0) {
      await alertStaff('An invoice was overpaid', `Invoice balance is now a credit of ${naira(-balanceKobo)} (payment ${payment.reference}). Consider a refund.`, { paymentId: payment.id });
    }
    await recordSafely(audit, {
      action: 'PAYMENT_CONFIRMED', entityType: 'payment', entityId: payment.id,
      metadata: { source: options.source, receiptNo: fresh.receiptNo, amountKobo: payment.amountKobo, feeKobo: payment.feeKobo, late: payment.status !== PAYMENT_STATUS.PENDING },
    });
    return { outcome: 'CONFIRMED', payment: fresh };
  }

  return { confirm };
}

export type ConfirmationService = ReturnType<typeof createConfirmationService>;