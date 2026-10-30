import { logger } from '../common/utils/logger';
import { isProduction } from '../config/env';

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
    },
  };
}

export const createMailer = (): Mailer => (isProduction ? createDisabledMailer() : createConsoleMailer());