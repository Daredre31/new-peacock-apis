import { ERROR_CODES, type ErrorCode } from './errorCodes';

export interface ErrorDetail {
  field: string;
  issue: string;
}

export interface AppErrorOptions {
  /** Client-safe message. Defaults to the standard message for the code. */
  message?: string;
  details?: ErrorDetail[];
  /** Seconds, used with RATE_LIMITED. */
  retryAfter?: number;
  /** The underlying error. Logged on the server, never sent to the client. */
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: ErrorDetail[];
  readonly retryAfter?: number;
  /** True for errors we raise on purpose. Anything else is treated as a bug. */
  readonly isOperational = true;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    const definition = ERROR_CODES[code];
    super(options.message ?? definition.message, { cause: options.cause });

    this.name = 'AppError';
    this.code = code;
    this.statusCode = definition.status;
    this.details = options.details;
    this.retryAfter = options.retryAfter;

    Error.captureStackTrace(this, AppError);
  }
}

export const isAppError = (value: unknown): value is AppError => value instanceof AppError;