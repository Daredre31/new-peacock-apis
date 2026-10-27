import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { env } from '../../config/env';

const SENSITIVE_KEYS = [
  'password',
  'newPassword',
  'currentPassword',
  'confirmPassword',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'resetToken',
  'csrfToken',
  'secret',
  'apiKey',
  'authorization',
  'cookie',
];

// Redaction is key based, so we cover the key at the top level and up to
// two levels of nesting (for example body.password, user.credentials.token).
const REDACT_PATHS = [
  ...SENSITIVE_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]),
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
];

interface CreateLoggerOptions {
  level?: string;
  destination?: DestinationStream;
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const config: LoggerOptions = {
    level: options.level ?? env.LOG_LEVEL,
    base: { service: 'peacock-academy-api', env: env.NODE_ENV },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
    },
  };

  if (options.destination) {
    return pino(config, options.destination);
  }

  // Readable logs on your machine only. Production emits plain JSON for log tools.
  if (env.NODE_ENV === 'development') {
    config.transport = {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname,service,env' },
    };
  }

  return pino(config);
}

export const logger = createLogger();

export const childLogger = (bindings: Record<string, unknown>): Logger => logger.child(bindings);