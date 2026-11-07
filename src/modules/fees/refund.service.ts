import { AppError } from '../../common/errors/AppError';
import { isDuplicateKeyError } from '../../common/utils/mongoErrors';
import { formatNaira } from '../../common/utils/money';
import { logger } from '../../common/utils/logger';
import { ROLES } from '../../config/constants';
import { withTransaction } from '../../config/db';
import type { PaystackClient } from '../../integrations/paystack';
import { recordSafely, type AuditPort } from '../audit/audit.port';
import type { NotificationService } from '../notifications/notification.service';
import type { RequestDecidedEvent } from '../requests/request.events';
import type { linkRepository } from '../users/link.repository';
import type { userRepository } from '../users/user.repository';
import type { LedgerService } from './ledger.service';
import type { PaymentRecord, paymentRepository } from './payment.repository';
import type { EventRecord } from './paystackEvent.repository';
import {  type RefundRecord, type RefundStatus, type refundRepository } from './refund.repository';

const naira = (kobo: number): string => `NGN ${formatNaira(kobo)}`;

export function createRefundService(deps: {
  refunds: typeof refundRepository;
  payments: Pick<typeof paymentRepository, 'findById' | 'findByReference' | 'addRefund'>;
  ledger: LedgerService;
  paystack: Pick<PaystackClient, 'createRefund' | 'fetchRefund'>;
  links: Pick<typeof linkRepository, 'activeParentIdsOf'>;
  users: Pick<typeof userRepository, 'findIdsByRoles'>;
  notifier: Pick<NotificationService, 'notify'>;
  audit: AuditPort;
}) {
  const { refunds, payments, ledger, paystack, links, users, notifier, audit } = deps;

  async function alertOwner(title: string, body: string, data?: Record<string, string>): Promise<void> {
    await notifier.notify({ userIds: await users.findIdsByRoles([ROLES.SUPER_ADMIN]), type: 'REFUND_ALERT', title, body, ...(data ? { data } : {}), email: true });
  }

  /** The ledger changes only here, when Paystack has confirmed the money went back. */
  async function complete(refund: RefundRecord): Promise<void> {
    let applied = false;
    try {
      await withTransaction(async (session) => {
        applied = false;
        const payment = await payments.findById(refund.paymentId, session);
        if (!payment) throw new AppError('NOT_FOUND');
        if (!(await refunds.markProcessed(refund.id, session))) return; // already completed
        if (!(await payments.addRefund(payment.id, payment.refundedKobo, refund.amountKobo, session))) {
          throw new AppError('CONFLICT', { message: 'The payment changed while the refund was being recorded' });
        }
        await ledger.post(
          { invoiceId: payment.invoiceId, studentId: payment.studentId, type: 'REFUND', amountKobo: refund.amountKobo, requestId: refund.requestId, refPaymentId: payment.id, note: 'Online refund processed', createdBy: refund.createdBy },
          'ANY', session,
        );
        applied = true;
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) return;
      throw err;
    }
    if (!applied) return;

    const payment = await payments.findById(refund.paymentId);
    if (payment) {
      await notifier.notify({ userIds: await links.activeParentIdsOf([payment.studentId]), type: 'REFUND_APPLIED', title: 'A refund was processed', body: `${naira(refund.amountKobo)} was refunded to your original payment method.`, data: { paymentId: payment.id }, email: true });
    }
    await recordSafely(audit, { action: 'ONLINE_REFUND_PROCESSED', entityType: 'refund', entityId: refund.id, metadata: { amountKobo: refund.amountKobo } });
  }

  async function failed(refund: RefundRecord, reason: string): Promise<void> {
    if (!(await refunds.markFailed(refund.id, reason))) return;
    await alertOwner('An online refund failed', `Refund ${refund.id} of ${naira(refund.amountKobo)} failed: ${reason}. The money stays with the school. Please handle it in the Paystack dashboard.`, { refundId: refund.id });
    await recordSafely(audit, { action: 'ONLINE_REFUND_FAILED', entityType: 'refund', entityId: refund.id, metadata: { reason } });
  }

  return {
    /** Called when the super admin approves a refund of an online payment. Throws if it cannot start, so the hook can tell people. */
    async startOnlineRefund(event: RequestDecidedEvent, payment: PaymentRecord): Promise<void> {
      const amount = event.payload.amountKobo;
      if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) throw new AppError('CONFLICT', { message: 'The refund amount is not valid' });

      const available = payment.amountKobo - payment.refundedKobo - (await refunds.reservedTotal(payment.id));
      if (amount > available) throw new AppError('CONFLICT', { message: `More than the refundable amount of ${naira(available)}` });

      const created = await refunds.create({ paymentId: payment.id, requestId: event.requestId, amountKobo: amount, createdBy: event.decidedBy });
      if (!created) return; // this decision already started a refund

      // Only the invoice amount is refunded, never the NGN online fee.
      const result = await paystack.createRefund({ reference: payment.reference, amountKobo: amount, note: `Refund ${event.reference}` });
      if (result.ok) {
        await refunds.markPending(created.id, String(result.data.id));
        if (result.data.status === 'processed') await complete(created);
        else if (result.data.status === 'failed') await failed(created, 'Paystack reported the refund as failed');
        return;
      }
      if (result.kind === 'REJECTED') {
        await refunds.markFailed(created.id, result.message || 'Refused by Paystack');
        throw new AppError('CONFLICT', { message: `Paystack refused the refund: ${result.message || 'no reason given'}` });
      }
      // We do not know whether Paystack created it. Hold the amount and ask a human to look.
      await refunds.markUncertain(created.id, result.kind);
      await alertOwner('An online refund needs checking', `Refund ${created.id} of ${naira(amount)} on payment ${payment.reference}: we could not confirm whether Paystack received it. Check the Paystack dashboard. If it exists, it will complete on its own. If it does not, cancel this refund in the app.`, { refundId: created.id });
    },

    /** A refund.* webhook event. We use only the status from it, never an amount, to decide what to do with OUR record. */
    async onProviderEvent(ev: EventRecord): Promise<void> {
      if (!ev.reference) return;
      const payment = await payments.findByReference(ev.reference);
      const open = payment ? await refunds.openForPayment(payment.id) : [];
      const amount = typeof ev.fields.amount === 'number' ? ev.fields.amount : null;
      const match = open.find((r) => amount === null || r.amountKobo === amount) ?? (open.length === 1 ? open[0] : undefined);
      if (!payment || !match) {
        await alertOwner('A refund event did not match a refund', `Paystack sent ${ev.event} for ${ev.reference}, but no open refund matches it. Please check the Paystack dashboard.`);
        return;
      }

      const status = String(ev.fields.status ?? ev.event.replace('refund.', '')).toLowerCase();
      if (status === 'processed') await complete(match);
      else if (status === 'failed') await failed(match, 'Paystack reported the refund as failed');
      else if (status === 'needs-attention') await alertOwner('A refund needs attention', `Paystack needs action on refund ${match.id} (${naira(match.amountKobo)}). Please open it in the Paystack dashboard.`, { refundId: match.id });
      else await refunds.markPending(match.id, match.providerRefundId ?? String(ev.fields.providerId ?? ''));
    },

    /** Refunds whose webhook never came are checked directly. */
    async sweepPending(): Promise<void> {
      for (const refund of await refunds.pendingOlderThan(new Date(Date.now() - 20 * 60_000), 50)) {
        if (!refund.providerRefundId) continue;
        const result = await paystack.fetchRefund(refund.providerRefundId);
        if (!result.ok) continue;
        try {
          if (result.data.status === 'processed') await complete(refund);
          else if (result.data.status === 'failed') await failed(refund, 'Paystack reported the refund as failed');
        } catch (err) {
          logger.error({ err, refundId: refund.id }, 'could not settle a pending refund');
        }
      }
    },

    /** For a refund we could not confirm, after the super admin checked Paystack and found nothing. */
    async cancel(actor: { id: string }, id: string, ctx: { ip: string; requestId: string }) {
      const refund = await refunds.findById(id);
      if (!refund) throw new AppError('NOT_FOUND');
      const updated = await refunds.markFailed(id, 'Cancelled after checking Paystack');
      if (!updated) throw new AppError('CONFLICT', { message: 'Only a refund that is not yet settled can be cancelled' });
      await recordSafely(audit, { action: 'ONLINE_REFUND_CANCELLED', actorId: actor.id, entityType: 'refund', entityId: id, ip: ctx.ip, requestId: ctx.requestId });
      return { id, status: updated.status };
    },

    list: (input: { page: number; limit: number; status?: RefundStatus | undefined }) => refunds.list({ status: input.status }, { page: input.page, limit: input.limit }),
  };
}

export type RefundService = ReturnType<typeof createRefundService>;
// void REFUND_STATUS;