import { formatNaira } from '../../common/utils/money';
import { logger } from '../../common/utils/logger';
import { ROLES } from '../../config/constants';
import type { PaystackClient } from '../../integrations/paystack';
import type { NotificationService } from '../notifications/notification.service';
import type { userRepository } from '../users/user.repository';
import type { ConfirmationService } from './confirmation.service';
import type { invoiceRepository } from './invoice.repository';
import type { ledgerRepository } from './ledger.repository';
import { ONLINE_REFERENCE_PREFIX, PAYMENT_STATUS, type paymentRepository } from './payment.repository';
import type { paystackEventRepository } from './paystackEvent.repository';
import type { Discrepancy, RunKind, reconciliationRepository } from './reconciliation.repository';
import type { RefundService } from './refund.service';
import type { WebhookProcessor } from './webhook';

const ABANDON_AFTER_MS = 2 * 60 * 60_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
/** Everything except a late payment that was found and credited needs a human to look. */
const INFO_ONLY = new Set(['LATE_PAYMENT_CREDITED']);

export function createPaymentOps(deps: {
  payments: typeof paymentRepository;
  invoices: Pick<typeof invoiceRepository, 'findById'>;
  ledger: Pick<typeof ledgerRepository, 'existsForPayment' | 'sumForInvoice'>;
  events: Pick<typeof paystackEventRepository, 'listDue'>;
  runs: typeof reconciliationRepository;
  processor: WebhookProcessor;
  confirmation: ConfirmationService;
  refunds: Pick<RefundService, 'sweepPending'>;
  paystack: Pick<PaystackClient, 'listSuccessful'>;
  users: Pick<typeof userRepository, 'findIdsByRoles'>;
  notifier: Pick<NotificationService, 'notify'>;
}) {
  const { payments, invoices, ledger, events, runs, processor, confirmation, refunds, paystack, users, notifier } = deps;

  return {
    /** Runs every minute: saved webhook events that were not processed, pending payments, pending refunds. */
    async sweep(): Promise<void> {
      for (const ev of await events.listDue(new Date(), 50)) {
        try { await processor.process(ev.id); } catch (err) { logger.error({ err, eventId: ev.id }, 'sweep: event failed'); }
      }

      const now = Date.now();
      for (const p of await payments.listPendingForSweep(new Date(now - 3 * 60_000), new Date(now - 2 * 60_000), 50)) {
        try {
          const result = await confirmation.confirm(p.reference, { source: 'SWEEP' });
          // Paystack itself said "not paid" for two hours. A late success is still credited if it ever comes.
          if (result.outcome === 'NOT_PAID_YET' && now - p.createdAt.getTime() > ABANDON_AFTER_MS) await payments.markAbandoned(p.id);
        } catch (err) {
          logger.error({ err, paymentId: p.id }, 'sweep: payment failed');
        }
      }
      await refunds.sweepPending();
    },

    /** Compares Paystack's record of successful payments with ours and checks the books add up. */
    async reconcile(input: { days: number; triggeredBy: string | null; kind: RunKind }) {
      const windowTo = new Date();
      const windowFrom = new Date(windowTo.getTime() - input.days * 86_400_000);
      const runId = await runs.start({ kind: input.kind, windowFrom, windowTo, triggeredBy: input.triggeredBy });
      const found: Discrepancy[] = [];
      let checked = 0;
      let fixed = 0;
      let complete = true;

      try {
        const seen = new Set<string>();
        for (let page = 1; page <= MAX_PAGES; page += 1) {
          const result = await paystack.listSuccessful({ from: windowFrom, to: windowTo, page, perPage: PAGE_SIZE });
          if (!result.ok) { complete = false; found.push({ kind: 'PAYSTACK_UNAVAILABLE', reference: null, detail: result.kind }); break; }

          for (const tx of result.data) {
            if (!tx.reference.startsWith(ONLINE_REFERENCE_PREFIX)) continue;
            checked += 1;
            seen.add(tx.reference);
            const payment = await payments.findByReference(tx.reference);
            if (!payment) { found.push({ kind: 'ORPHAN_PAYSTACK_TRANSACTION', reference: tx.reference, detail: `Paystack received NGN ${formatNaira(tx.amount)} but we have no such payment` }); continue; }
            if (payment.status === PAYMENT_STATUS.SUCCESS || payment.status === PAYMENT_STATUS.REVERSED) {
              if (tx.amount !== payment.totalChargeKobo) found.push({ kind: 'AMOUNT_MISMATCH', reference: tx.reference, detail: `We expected NGN ${formatNaira(payment.totalChargeKobo)}, Paystack has NGN ${formatNaira(tx.amount)}` });
              continue;
            }
            if (payment.status === PAYMENT_STATUS.NEEDS_REVIEW) { found.push({ kind: 'STILL_NEEDS_REVIEW', reference: tx.reference, detail: 'Paid at Paystack but flagged for review' }); continue; }

            const outcome = await confirmation.confirm(tx.reference, { source: 'RECONCILE' }); // paid at Paystack but not credited here
            if (outcome.outcome === 'CONFIRMED') { fixed += 1; found.push({ kind: 'LATE_PAYMENT_CREDITED', reference: tx.reference, detail: `Credited NGN ${formatNaira(payment.amountKobo)} that the webhook had missed` }); }
            else if (outcome.outcome === 'MISMATCH') found.push({ kind: 'AMOUNT_MISMATCH', reference: tx.reference, detail: 'Paid at Paystack with a different amount; flagged for review' });
            else if (outcome.outcome === 'UNAVAILABLE') complete = false;
          }
          if (page >= (result.pageCount ?? 1)) break;
          if (page === MAX_PAGES) complete = false;
        }

        const ours = await payments.listSuccessfulOnlineBetween(windowFrom, windowTo);
        for (const p of ours) {
          if (complete && !seen.has(p.reference)) found.push({ kind: 'MISSING_AT_PAYSTACK', reference: p.reference, detail: 'We recorded this as paid but Paystack did not list it. Check by hand' });
          if (!(await ledger.existsForPayment(p.id, 'PAYMENT'))) found.push({ kind: 'MISSING_LEDGER_ENTRY', reference: p.reference, detail: 'Marked paid but there is no ledger entry' });
        }
        for (const invoiceId of new Set(ours.map((p) => p.invoiceId))) {
          const invoice = await invoices.findById(invoiceId);
          if (invoice && (await ledger.sumForInvoice(invoiceId)) !== invoice.balanceKobo) found.push({ kind: 'INVOICE_DRIFT', reference: invoice.number, detail: 'The invoice balance does not equal the sum of its ledger entries' });
        }

        const run = await runs.finish(runId, { checked, fixed, complete, discrepancies: found });
        const alerts = found.filter((d) => !INFO_ONLY.has(d.kind)).length;
        if (alerts > 0 || !complete) {
          await notifier.notify({
            userIds: await users.findIdsByRoles([ROLES.SUPER_ADMIN]), type: 'RECONCILIATION_ALERT', title: 'Payment reconciliation found problems',
            body: `${alerts} discrepancies${complete ? '' : ' (and the check could not finish)'} in the last ${input.days} days. Open the reconciliation report.`, data: { runId }, email: true,
          });
        }
        return run;
      } catch (err) {
        logger.error({ err }, 'reconciliation failed');
        await runs.fail(runId, err instanceof Error ? err.message : 'error');
        await notifier.notify({ userIds: await users.findIdsByRoles([ROLES.SUPER_ADMIN]), type: 'RECONCILIATION_ALERT', title: 'Payment reconciliation failed', body: 'The check could not run. Please look at the server logs.', email: true });
        return null;
      }
    },

    listRuns: (input: { page: number; limit: number }) => runs.list(input),
  };
}

export type PaymentOps = ReturnType<typeof createPaymentOps>;