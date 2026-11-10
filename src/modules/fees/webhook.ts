import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { logger } from '../../common/utils/logger';
import { ADMISSION_REFERENCE_PREFIX, ROLES } from '../../config/constants';
import { recordSafely, type AuditPort } from '../audit/audit.port';
import type { NotificationService } from '../notifications/notification.service';
import type { userRepository } from '../users/user.repository';
import type { ConfirmationService } from './confirmation.service';
import { type EventFields, type EventRecord, type paystackEventRepository } from './paystackEvent.repository';
import { ONLINE_REFERENCE_PREFIX } from './payment.repository';
import type { RefundService } from './refund.service';

const bodySchema = z.object({ event: z.string().min(1).max(60), data: z.record(z.string(), z.unknown()).optional() });

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length < 200 ? v : null);
/** Paystack sometimes sends amounts as strings, so numeric strings are accepted. */
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isSafeInteger(n) ? n : null;
};

/** Keeps only a small safe subset of the event. Card details and everything else are dropped. */
function summarize(data: Record<string, unknown> | undefined): { reference: string | null; fields: EventFields } {
  const d = data ?? {};
  const nested = typeof d.transaction === 'object' && d.transaction !== null ? (d.transaction as Record<string, unknown>) : {};
  return {
    reference: str(d.reference) ?? str(d.transaction_reference) ?? str(nested.reference),
    fields: { status: str(d.status), amount: num(d.amount), currency: str(d.currency), refundReference: str(d.refund_reference), providerId: num(d.id) },
  };
}

function signatureMatches(secret: string, raw: Buffer, header: string): boolean {
  if (!/^[a-f0-9]{128}$/i.test(header)) return false;
  const expected = createHmac('sha512', secret).update(raw).digest();
  const given = Buffer.from(header, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Mounted BEFORE the JSON parser, so it receives the raw bytes the signature was made over.
 * It checks the signature, saves the event, answers 200, and only then lets the processor work.
 */
export function createPaystackWebhookHandler(deps: {
  secretKey: string | undefined;
  events: Pick<typeof paystackEventRepository, 'store'>;
  dispatch: (eventId: string) => void;
}): RequestHandler {
  return async (req, res) => {
    const log = req.log ?? logger;
    if (!deps.secretKey) { res.sendStatus(503); return; } // not set up: Paystack will retry later

    const raw: unknown = req.body;
    const signature = req.get('x-paystack-signature');
    if (!Buffer.isBuffer(raw) || raw.length === 0 || !signature) { res.sendStatus(400); return; }
    if (!signatureMatches(deps.secretKey, raw, signature)) {
      log.warn({ ip: req.ip }, 'paystack webhook rejected: bad signature');
      res.sendStatus(401);
      return;
    }

    let json: unknown;
    try { json = JSON.parse(raw.toString('utf8')); } catch { res.sendStatus(400); return; }
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) { log.warn('paystack webhook ignored: unexpected shape'); res.sendStatus(200); return; } // signed but useless: do not make Paystack retry

    const { reference, fields } = summarize(parsed.data.data);
    let stored: { id: string; duplicate: boolean };
    try {
      stored = await deps.events.store({ bodyHash: createHash('sha256').update(raw).digest('hex'), event: parsed.data.event, reference, fields });
    } catch (err) {
      log.error({ err }, 'could not save a paystack event');
      res.sendStatus(500); // saving failed, so ask Paystack to send it again
      return;
    }

    res.status(200).json({ received: true });
    if (!stored.duplicate) deps.dispatch(stored.id);
  };
}

/** Does the work for one saved event. Anything that fails is retried later with a growing delay. */
export function createWebhookProcessor(deps: {
  events: typeof paystackEventRepository;
  confirmation: ConfirmationService;
  refunds: Pick<RefundService, 'onProviderEvent'>;
  users: Pick<typeof userRepository, 'findIdsByRoles'>;
  notifier: Pick<NotificationService, 'notify'>;
  audit: AuditPort;
  /** Application fees for admission. Their references start with ADM-. */
  admissionPayments?: { confirm(reference: string): Promise<'CONFIRMED' | 'ALREADY' | 'NOT_PAID_YET' | 'FAILED' | 'MISMATCH' | 'UNAVAILABLE' | 'UNKNOWN'> };
}) {
  const { events, confirmation, refunds, users, notifier, audit, admissionPayments } = deps;

  async function alertOwner(title: string, body: string): Promise<void> {
    await notifier.notify({ userIds: await users.findIdsByRoles([ROLES.SUPER_ADMIN]), type: 'PAYMENT_ALERT', title, body, email: true });
  }

  async function handle(ev: EventRecord): Promise<'PROCESSED' | 'IGNORED'> {
    if (ev.event === 'charge.success') {
      if (ev.reference && ev.reference.startsWith(ADMISSION_REFERENCE_PREFIX)) {
        if (!admissionPayments) return 'IGNORED';
        const outcome = await admissionPayments.confirm(ev.reference);
        if (outcome === 'UNAVAILABLE' || outcome === 'NOT_PAID_YET') throw new Error(`admission payment not confirmed yet (${outcome})`);
        if (outcome === 'UNKNOWN') {
          await alertOwner('Unknown admission payment', `Paystack reported an application fee payment (${ev.reference}) that is not in our records. Please check the Paystack dashboard.`);
          return 'IGNORED';
        }
        return 'PROCESSED';
      }
      if (!ev.reference || !ev.reference.startsWith(ONLINE_REFERENCE_PREFIX)) return 'IGNORED'; // not one of ours
      const result = await confirmation.confirm(ev.reference, { source: 'WEBHOOK' });
      switch (result.outcome) {
        case 'UNKNOWN':
          await alertOwner('Unknown Paystack payment', `Paystack reported a payment (${ev.reference}) that is not in our records. Please check the Paystack dashboard.`);
          return 'IGNORED';
        case 'UNAVAILABLE':
        case 'NOT_PAID_YET':
          throw new Error(`not confirmed yet (${result.outcome})`); // Paystack said success but the check disagrees: try again shortly
        default:
          return 'PROCESSED';
      }
    }
    if (ev.event.startsWith('refund.')) { await refunds.onProviderEvent(ev); return 'PROCESSED'; }
    if (ev.event.startsWith('charge.dispute.')) {
      await alertOwner('A payment dispute was opened', `Paystack reported a dispute (${ev.event}) on ${ev.reference ?? 'a transaction'}. Please review it in the Paystack dashboard.`);
      await recordSafely(audit, { action: 'PAYMENT_DISPUTE_EVENT', entityType: 'payment', metadata: { event: ev.event, reference: ev.reference } });
      return 'PROCESSED';
    }
    return 'IGNORED';
  }

  return {
    async process(eventId: string): Promise<void> {
      const now = new Date();
      const ev = await events.claim(eventId, now, new Date(now.getTime() - 5 * 60_000));
      if (!ev) return; // someone else has it, or it is done
      try {
        await events.finish(ev.id, await handle(ev));
      } catch (err) {
        logger.error({ err, eventId: ev.id, event: ev.event }, 'paystack event processing failed');
        const { failed } = await events.retryLater(ev.id, err instanceof Error ? err.message : 'error', new Date());
        if (failed) await alertOwner('A Paystack event could not be processed', `${ev.event} (${ev.reference ?? 'no reference'}) failed ${ev.attempts} times. Please check it by hand.`);
      }
    },
  };
}

export type WebhookProcessor = ReturnType<typeof createWebhookProcessor>;
// void EVENT_STATUS;