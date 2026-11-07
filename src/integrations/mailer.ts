import { logger } from '../common/utils/logger';
import { env, isProduction } from '../config/env';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** Development only: prints the email, including any reset link, so you can click or copy it. */
export function createConsoleMailer(): Mailer {
  return {
    send: async (message) => {
      logger.info({ mail: message }, 'EMAIL (development mailer, not really sent)');
    },
  };
}

/** Production until a provider is chosen. Nothing is sent and the log never contains the email body. */
export function createDisabledMailer(): Mailer {
  return {
    send: async (message) => {
      logger.error({ to: message.to, subject: message.subject }, 'email not sent: no mail provider configured');
      throw new Error('No mail provider configured');
    },
  };
}

export interface ResendOptions {
  apiKey: string;
  /** Verified sender, e.g. "Peacock Academy <no-reply@yourschool.com>". */
  from: string;
  /** Overridable for tests. */
  baseUrl?: string;
  /** Minimum gap between requests. Resend allows 2 requests a second by default. */
  minGapMs?: number;
  maxRetries?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends through Resend's HTTP API (no extra package). Requests go out one at a time, spaced
 * to stay under Resend's rate limit, and a 429 or 5xx answer is retried a few times.
 * Errors never include the email body.
 */
export function createResendMailer(options: ResendOptions): Mailer {
  const baseUrl = options.baseUrl ?? 'https://api.resend.com';
  const minGap = options.minGapMs ?? 550;
  const maxRetries = options.maxRetries ?? 3;
  let chain: Promise<unknown> = Promise.resolve();
  let lastSent = 0;

  async function deliver(message: MailMessage): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const wait = lastSent + minGap - Date.now();
      if (wait > 0) await sleep(wait);
      lastSent = Date.now();
      let res: Response;
      try {
        res = await fetch(`${baseUrl}/emails`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: options.from, to: [message.to], subject: message.subject, text: message.text }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (err) {
        if (attempt < maxRetries) { await sleep(500 * 2 ** attempt); continue; }
        throw new Error(`Resend request failed: ${err instanceof Error ? err.message : 'network error'}`);
      }
      if (res.ok) return;
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < maxRetries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 5) * 1000 : 500 * 2 ** attempt);
        continue;
      }
      const detail = await res.text().then((t) => t.slice(0, 300)).catch(() => '');
      logger.error({ to: message.to, subject: message.subject, status: res.status, detail }, 'resend rejected the email');
      throw new Error(`Resend answered ${res.status}`);
    }
  }

  return {
    send: (message) => {
      const run = chain.then(() => deliver(message));
      chain = run.catch(() => undefined);
      return run;
    },
  };
}

export function createMailer(): Mailer {
  if (env.RESEND_API_KEY && env.MAIL_FROM) {
    return createResendMailer({ apiKey: env.RESEND_API_KEY, from: env.MAIL_FROM });
  }
  return isProduction ? createDisabledMailer() : createConsoleMailer();
}
