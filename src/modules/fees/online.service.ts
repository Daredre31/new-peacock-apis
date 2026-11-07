import { createHash } from 'node:crypto';
import { AppError } from '../../common/errors/AppError';
import type { ScopeService } from '../../common/scope/scope.service';
import { formatNaira, isKobo } from '../../common/utils/money';
import { isProduction } from '../../config/env';
import type { PaystackClient } from '../../integrations/paystack';
import { recordSafely, type AuditPort } from '../audit/audit.port';
import type { SettingsService } from '../settings/settings.service';
import type { studentRepository } from '../users/student.repository';
import type { userRepository } from '../users/user.repository';
import type { ConfirmationService } from './confirmation.service';
import type { invoiceRepository } from './invoice.repository';
import { PAYMENT_STATUS, type PaymentRecord, type paymentRepository } from './payment.repository';

interface Actor { id: string; role: Express.AuthUser['role'] }
interface Context { ip: string; requestId: string }

/** A payment still open this long is treated as "in progress": the same request returns the same checkout link. */
const REUSE_WINDOW_MS = 30 * 60_000;
const naira = (kobo: number): string => `NGN ${formatNaira(kobo)}`;
const fail = (field: string, issue: string): AppError => new AppError('VALIDATION_ERROR', { details: [{ field, issue }] });

/** Real Paystack checkout links are https. Plain http is allowed only for the local fake server, and never in production. */
const isSafeCheckoutUrl = (url: string): boolean =>
  url.startsWith('https://') || (!isProduction && url.startsWith('http://localhost'));

export const statusView = (p: PaymentRecord) => ({
  paymentId: p.id, reference: p.reference, status: p.status, invoiceId: p.invoiceId, amountKobo: p.amountKobo, feeKobo: p.feeKobo,
  totalChargeKobo: p.totalChargeKobo, receiptNo: p.receiptNo, failureReason: p.failureReason, paidAt: p.paidAt ? p.paidAt.toISOString() : null,
  canRecheck: p.status === PAYMENT_STATUS.PENDING || p.status === PAYMENT_STATUS.ABANDONED,
});

export function createOnlinePaymentService(deps: {
  payments: typeof paymentRepository;
  invoices: Pick<typeof invoiceRepository, 'findById'>;
  users: Pick<typeof userRepository, 'findById'>;
  students: Pick<typeof studentRepository, 'profileMap'>;
  settings: Pick<SettingsService, 'getPolicy'>;
  scope: Pick<ScopeService, 'assertCanAccessStudent'>;
  confirmation: ConfirmationService;
  paystack: Pick<PaystackClient, 'initialize' | 'isConfigured'>;
  returnUrl: string;
  audit: AuditPort;
}) {
  const { payments, invoices, users, students, settings, scope, confirmation, paystack, returnUrl, audit } = deps;

  /** The smallest part payment: the policy percent of the invoice total, or the whole balance if that is smaller. */
  const minimumOf = (invoice: { totalKobo: number; balanceKobo: number }, percent: number): number =>
    Math.min(invoice.balanceKobo, Math.max(1, Math.ceil((invoice.totalKobo * percent) / 100)));

  async function loadInvoice(actor: Actor, invoiceId: string) {
    const invoice = await invoices.findById(invoiceId);
    if (!invoice) throw new AppError('NOT_FOUND');
    await scope.assertCanAccessStudent(actor, invoice.studentId); // a stranger's invoice is a 404
    return invoice;
  }

  async function mustOwnPayment(actor: Actor, reference: string): Promise<PaymentRecord> {
    const payment = await payments.findByReference(reference);
    if (!payment || payment.method !== 'ONLINE') throw new AppError('NOT_FOUND');
    await scope.assertCanAccessStudent(actor, payment.studentId);
    return payment;
  }

  return {
    /** What a payment would cost, so the app can show it before the parent commits. Nothing is created. */
    async quote(actor: Actor, input: { invoiceId: string; amountKobo?: number | undefined }) {
      const invoice = await loadInvoice(actor, input.invoiceId);
      const policy = await settings.getPolicy();
      const amount = input.amountKobo ?? invoice.balanceKobo;
      return {
        invoiceId: invoice.id, totalKobo: invoice.totalKobo, balanceKobo: invoice.balanceKobo,
        minAmountKobo: invoice.balanceKobo > 0 ? minimumOf(invoice, policy.minPartPaymentPercent) : 0,
        amountKobo: amount, feeKobo: policy.onlinePaymentFeeKobo, totalChargeKobo: amount + policy.onlinePaymentFeeKobo,
        canPayOnline: paystack.isConfigured() && invoice.balanceKobo > 0,
      };
    },

    async initialize(actor: Actor, input: { invoiceId: string; amountKobo: number }, idemKey: string, ctx: Context) {
      if (!paystack.isConfigured()) throw new AppError('SERVICE_UNAVAILABLE', { message: 'Online payments are not available yet' });
      if (!isKobo(input.amountKobo)) throw fail('amountKobo', 'Must be a whole number of kobo greater than zero');

      // The same Idempotency-Key with the same request returns what was already created.
      const hash = createHash('sha256').update(`${input.invoiceId}|${input.amountKobo}`).digest('hex');
      const replay = await payments.findByIdempotency(actor.id, idemKey);
      if (replay) {
        if (replay.idemHash !== hash) throw new AppError('CONFLICT', { message: 'This Idempotency-Key was already used for a different payment' });
        if (replay.status === PAYMENT_STATUS.PENDING && !replay.checkoutUrl) {
          await payments.markFailed(replay.id, 'No checkout was created', null);
          throw new AppError('CONFLICT', { message: 'That attempt did not go through. Please try again.' });
        }
        if (replay.status === PAYMENT_STATUS.FAILED) throw new AppError('CONFLICT', { message: 'That attempt did not go through. Please try again.' });
        return { ...statusView(replay), checkoutUrl: replay.status === PAYMENT_STATUS.PENDING ? replay.checkoutUrl : null, reused: true };
      }

      const invoice = await loadInvoice(actor, input.invoiceId);
      if (invoice.balanceKobo <= 0) throw new AppError('FEE_ALREADY_PAID');
      const policy = await settings.getPolicy();
      const minimum = minimumOf(invoice, policy.minPartPaymentPercent);
      if (input.amountKobo > invoice.balanceKobo) {
        throw new AppError('PAYMENT_AMOUNT_INVALID', { message: `The amount is more than the outstanding balance of ${naira(invoice.balanceKobo)}` });
      }
      if (input.amountKobo < minimum) {
        throw new AppError('PAYMENT_AMOUNT_INVALID', { message: `The smallest part payment is ${naira(minimum)}` });
      }

      const email = (await users.findById(actor.id))?.email;
      if (!email) throw fail('email', 'There is no email address on your account. Please ask the school office to add one, then try again');

      // A payment of yours is already in progress for this invoice.
      const open = (await payments.listOpenForInvoice(invoice.id)).filter(
        (p) => p.payerId === actor.id && Date.now() - p.createdAt.getTime() < REUSE_WINDOW_MS,
      );
      const same = open.find((p) => p.amountKobo === input.amountKobo && p.checkoutUrl);
      if (same) return { ...statusView(same), checkoutUrl: same.checkoutUrl, reused: true };
      if (open.length > 0) {
        throw new AppError('PAYMENT_PENDING', {
          message: 'You have a payment in progress for this invoice. If you already paid, use "I paid but it is not showing". Otherwise wait a few minutes and try again.',
        });
      }

      const id = payments.newId();
      const reference = payments.newOnlineReference();
      const feeKobo = policy.onlinePaymentFeeKobo;
      let payment: PaymentRecord;
      try {
        // Written BEFORE Paystack is called: whatever happens next, this payment is on the record.
        payment = await payments.createPending({
          id, reference, invoiceId: invoice.id, studentId: invoice.studentId, payerId: actor.id,
          amountKobo: input.amountKobo, feeKobo, idemScope: actor.id, idemKey, idemHash: hash,
        });
      } catch (err) {
        const raced = await payments.findByIdempotency(actor.id, idemKey); // a double click created it a moment ago
        if (raced) return { ...statusView(raced), checkoutUrl: raced.checkoutUrl, reused: true };
        throw err;
      }

      const profile = (await students.profileMap([invoice.studentId])).get(invoice.studentId);
      const result = await paystack.initialize({
        email, amountKobo: payment.totalChargeKobo, reference, callbackUrl: returnUrl,
        // For people reading the Paystack dashboard. Never trusted, and no names or card data.
        metadata: {
          paymentId: id, invoiceId: invoice.id,
          custom_fields: [
            { display_name: 'Invoice', variable_name: 'invoice', value: invoice.number },
            { display_name: 'Admission number', variable_name: 'admission_no', value: profile?.admissionNo ?? '' },
          ],
        },
      });

      if (!result.ok || result.data.reference !== reference || !isSafeCheckoutUrl(result.data.authorization_url)) {
        const refused = !result.ok && result.kind === 'REJECTED';
        await payments.markFailed(id, refused ? 'Refused by the payment provider' : 'Could not reach the payment provider', null);
        await recordSafely(audit, {
          action: 'PAYMENT_INIT_FAILED', actorId: actor.id, entityType: 'payment', entityId: id, ip: ctx.ip, requestId: ctx.requestId,
          metadata: { kind: result.ok ? 'INVALID_RESPONSE' : result.kind },
        });
        if (refused) throw fail('email', 'The payment provider refused this payment. Please check the email address on your account.');
        throw new AppError('SERVICE_UNAVAILABLE', { message: 'We could not start the payment. Nothing was charged. Please try again in a moment.' });
      }

      await payments.setCheckout(id, result.data.authorization_url, result.data.access_code);
      await recordSafely(audit, {
        action: 'PAYMENT_INITIALIZED', actorId: actor.id, entityType: 'payment', entityId: id, ip: ctx.ip, requestId: ctx.requestId,
        metadata: { invoiceId: invoice.id, amountKobo: input.amountKobo, feeKobo, reference },
      });
      return { ...statusView(payment), checkoutUrl: result.data.authorization_url, reused: false };
    },

    /** Read by the page the parent lands on after paying. It trusts nothing from the browser except the reference. */
    async status(actor: Actor, reference: string) {
      let payment = await mustOwnPayment(actor, reference);
      if (payment.status === PAYMENT_STATUS.PENDING) {
        await confirmation.confirm(reference, { source: 'POLL', minGapMs: 15_000 });
        payment = (await payments.findByReference(reference)) ?? payment;
      }
      return statusView(payment);
    },

    /** "I paid but it is not showing": asks Paystack now (at most once every few seconds). */
    async recheck(actor: Actor, reference: string) {
      const payment = await mustOwnPayment(actor, reference);
      const result = await confirmation.confirm(reference, { source: 'RECHECK', minGapMs: 4_000 });
      const fresh = (await payments.findByReference(reference)) ?? payment;
      return { ...statusView(fresh), outcome: result.outcome };
    },
  };
}

export type OnlinePaymentService = ReturnType<typeof createOnlinePaymentService>;