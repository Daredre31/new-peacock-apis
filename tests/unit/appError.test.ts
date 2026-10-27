import { describe, expect, it } from 'vitest';
import { AppError, isAppError } from '../../src/common/errors/AppError';
import { ERROR_CODES } from '../../src/common/errors/errorCodes';

describe('AppError', () => {
  it('takes status and default message from the code', () => {
    const err = new AppError('NOT_FOUND');
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe(ERROR_CODES.NOT_FOUND.message);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.isOperational).toBe(true);
  });

  it('is a real Error with a stack', () => {
    const err = new AppError('CONFLICT');
    expect(err).toBeInstanceOf(Error);
    expect(err.stack).toBeTruthy();
  });

  it('allows a custom message, details and retryAfter', () => {
    const err = new AppError('VALIDATION_ERROR', {
      message: 'Bad input',
      details: [{ field: 'email', issue: 'Invalid email' }],
    });
    expect(err.message).toBe('Bad input');
    expect(err.details).toEqual([{ field: 'email', issue: 'Invalid email' }]);

    const limited = new AppError('RATE_LIMITED', { retryAfter: 30 });
    expect(limited.retryAfter).toBe(30);
  });

  it('keeps the cause without exposing it as the message', () => {
    const cause = new Error('db exploded: password=hunter2');
    const err = new AppError('INTERNAL_ERROR', { cause });
    expect(err.cause).toBe(cause);
    expect(err.message).not.toContain('hunter2');
  });

  it('isAppError tells our errors from other errors', () => {
    expect(isAppError(new AppError('FORBIDDEN'))).toBe(true);
    expect(isAppError(new Error('x'))).toBe(false);
    expect(isAppError('nope')).toBe(false);
  });

  it('matches the status codes in the spec', () => {
    expect(ERROR_CODES.VALIDATION_ERROR.status).toBe(422);
    expect(ERROR_CODES.IMPORT_TOKEN_EXPIRED.status).toBe(410);
    expect(ERROR_CODES.RATE_LIMITED.status).toBe(429);
    expect(ERROR_CODES.SERVICE_UNAVAILABLE.status).toBe(503);
  });
});