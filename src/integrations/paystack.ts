import { z } from 'zod';
import { logger } from '../common/utils/logger';

export type PaystackFailureKind = 'NOT_CONFIGURED' | 'NETWORK' | 'TIMEOUT' | 'REJECTED' | 'NOT_FOUND' | 'INVALID_RESPONSE';
export interface PaystackFailure { ok: false; kind: PaystackFailureKind; status?: number; message: string }
export type PaystackResult<T> = { ok: true; data: T; pageCount: number | null } | PaystackFailure;

const envelope = z.object({
  status: z.boolean(),
  message: z.string().optional(),
  data: z.unknown(),
  meta: z.object({ pageCount: z.number().int().optional() }).optional(),
});

// Only the fields we need. Everything else, including card details, is dropped at the door.
const initializeData = z.object({ authorization_url: z.string(), access_code: z.string(), reference: z.string() });
const transactionData = z.object({
  id: z.number(), status: z.string(), reference: z.string(), amount: z.number(), currency: z.string(),
  gateway_response: z.string().nullish(), paid_at: z.string().nullish(),
});
const refundData = z.object({ id: z.number(), status: z.string(), amount: z.number().optional() });

export type PaystackTransaction = z.infer<typeof transactionData>;
export type PaystackRefund = z.infer<typeof refundData>;
export interface PaystackConfig { secretKey: string | undefined; baseUrl: string; timeoutMs?: number; fetchImpl?: typeof fetch }

export const paystackModeOf = (key: string | undefined): 'test' | 'live' | null =>
  key?.startsWith('sk_live_') ? 'live' : key?.startsWith('sk_test_') ? 'test' : null;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createPaystackClient(config: PaystackConfig) {
  const timeoutMs = config.timeoutMs ?? 10_000;
  const doFetch = config.fetchImpl ?? fetch;

  async function call<T>(path: string, req: { method: 'GET' | 'POST'; body?: Record<string, unknown>; schema: z.ZodType<T>; retries: number }): Promise<PaystackResult<T>> {
    const key = config.secretKey;
    if (!key) return { ok: false, kind: 'NOT_CONFIGURED', message: 'Paystack is not configured' };

    for (let attempt = 0; attempt <= req.retries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await doFetch(`${config.baseUrl}${path}`, {
          method: req.method,
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          ...(req.body ? { body: JSON.stringify(req.body) } : {}),
          signal: controller.signal,
        });
        const text = await res.text();
        let json: unknown = null;
        try { json = JSON.parse(text); } catch { json = null; }
        const parsed = envelope.safeParse(json);
        const message = parsed.success ? (parsed.data.message ?? '') : '';

        if (res.status === 404) return { ok: false, kind: 'NOT_FOUND', status: 404, message };
        if (res.status === 429 || res.status >= 500) {
          if (attempt < req.retries) { await sleep(300 * 2 ** attempt); continue; }
          return { ok: false, kind: 'NETWORK', status: res.status, message: 'The payment provider is not available' };
        }
        if (res.status === 401 || res.status === 403) logger.error({ status: res.status }, 'paystack refused our credentials');
        if (!res.ok) return { ok: false, kind: 'REJECTED', status: res.status, message: message.slice(0, 200) };
        if (!parsed.success) return { ok: false, kind: 'INVALID_RESPONSE', status: res.status, message: 'Unexpected response' };
        if (!parsed.data.status) return { ok: false, kind: 'REJECTED', status: res.status, message: message.slice(0, 200) };

        const data = req.schema.safeParse(parsed.data.data);
        if (!data.success) return { ok: false, kind: 'INVALID_RESPONSE', status: res.status, message: 'Unexpected response' };
        return { ok: true, data: data.data, pageCount: parsed.data.meta?.pageCount ?? null };
      } catch (err) {
        const aborted = err instanceof Error && err.name === 'AbortError';
        if (attempt < req.retries) { await sleep(300 * 2 ** attempt); continue; }
        logger.warn({ path: path.split('?')[0], kind: aborted ? 'TIMEOUT' : 'NETWORK' }, 'paystack request failed');
        return { ok: false, kind: aborted ? 'TIMEOUT' : 'NETWORK', message: aborted ? 'The payment provider took too long' : 'Could not reach the payment provider' };
      } finally {
        clearTimeout(timer);
      }
    }
    return { ok: false, kind: 'NETWORK', message: 'Could not reach the payment provider' };
  }

  return {
    isConfigured: (): boolean => Boolean(config.secretKey),
    mode: (): 'test' | 'live' | null => paystackModeOf(config.secretKey),

    /** Never retried: the reference is unique, so a retry would only be refused as a duplicate. */
    initialize: (input: { email: string; amountKobo: number; reference: string; callbackUrl: string; metadata: Record<string, unknown> }) =>
      call('/transaction/initialize', {
        method: 'POST', retries: 0, schema: initializeData,
        body: { email: input.email, amount: input.amountKobo, currency: 'NGN', reference: input.reference, callback_url: input.callbackUrl, metadata: input.metadata },
      }),

    verify: (reference: string) =>
      call(`/transaction/verify/${encodeURIComponent(reference)}`, { method: 'GET', retries: 2, schema: transactionData }),

    listSuccessful: (input: { from: Date; to: Date; page: number; perPage: number }) =>
      call(`/transaction?status=success&perPage=${input.perPage}&page=${input.page}&from=${encodeURIComponent(input.from.toISOString())}&to=${encodeURIComponent(input.to.toISOString())}`, {
        method: 'GET', retries: 2, schema: z.array(transactionData),
      }),

    /** Never retried: a retry could refund twice. */
    createRefund: (input: { reference: string; amountKobo: number; note: string }) =>
      call('/refund', {
        method: 'POST', retries: 0, schema: refundData,
        body: { transaction: input.reference, amount: input.amountKobo, currency: 'NGN', merchant_note: input.note, customer_note: input.note },
      }),

    fetchRefund: (id: string) => call(`/refund/${encodeURIComponent(id)}`, { method: 'GET', retries: 2, schema: refundData }),
  };
}

export type PaystackClient = ReturnType<typeof createPaystackClient>;