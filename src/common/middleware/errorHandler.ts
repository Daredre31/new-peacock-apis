import type { ErrorRequestHandler } from 'express';
import { AppError, isAppError } from '../errors/AppError';
import { sendError } from '../utils/apiResponse';
import { logger } from '../utils/logger';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object';

/** Turns anything that was thrown into an AppError that is safe to send to a client. */
function normalizeError(err: unknown): AppError {
  if (isAppError(err)) return err;

  if (isRecord(err)) {
    // Errors raised by Express's body parser.
    switch (err.type) {
      case 'entity.parse.failed':
        return new AppError('VALIDATION_ERROR', {
          message: 'Malformed request body',
          details: [{ field: 'body', issue: 'Malformed JSON' }],
        });
      case 'entity.too.large':
        return new AppError('VALIDATION_ERROR', { message: 'Request body is too large' });
      case 'encoding.unsupported':
      case 'charset.unsupported':
        return new AppError('VALIDATION_ERROR', { message: 'Unsupported request encoding' });
    }
          // Upload problems from multer (too large, too many parts).
    if (err.name === 'MulterError') {
      return new AppError('VALIDATION_ERROR', {
        message: err.code === 'LIMIT_FILE_SIZE' ? 'The file is larger than 2 MB' : 'The upload could not be processed',
        cause: err,
      });
    }
    // A unique index was violated and nothing caught it earlier. Safety net only:
    // services should check for duplicates and raise their own CONFLICT.
    if (err.code === 11000 && typeof err.name === 'string' && err.name.startsWith('Mongo')) {
      return new AppError('CONFLICT', { message: 'This record already exists', cause: err });
    }

    // Any other client error that carries a 4xx status (for example a bad URL encoding).
    const status = typeof err.status === 'number' ? err.status : err.statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return new AppError('VALIDATION_ERROR', {
        message: 'The request could not be processed',
        cause: err,
      });
    }
  }

  // Everything else is a bug. The client learns nothing except the requestId.
  return new AppError('INTERNAL_ERROR', { cause: err });
}

export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, next) => {
  const log = req.log ?? logger;
  const requestId = req.id ?? 'unknown';

  // The client disconnected mid-request. Nobody is left to answer.
  if (isRecord(err) && err.type === 'request.aborted') {
    log.debug({ requestId }, 'request aborted by client');
    return;
  }

  const appError = normalizeError(err);

  if (appError.statusCode >= 500) {
    log.error({ err, code: appError.code, status: appError.statusCode }, 'request failed');
  } else {
    log.info(
  { code: appError.code, status: appError.statusCode, method: req.method, url: req.originalUrl },
  'request rejected',
);
  }

  // A response is already streaming. We cannot send an envelope now,
  // so hand over to Express, which closes the connection.
  if (res.headersSent) {
    next(err);
    return;
  }

  sendError(res, appError, requestId);
};