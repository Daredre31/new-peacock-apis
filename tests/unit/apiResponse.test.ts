import type { Response } from 'express';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/common/errors/AppError';
import {
  buildCursorMeta,
  buildErrorBody,
  buildPageMeta,
  buildSuccessBody,
  sendCreated,
  sendError,
  sendSuccess,
} from '../../src/common/utils/apiResponse';

function mockRes() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(key: string, value: string) {
      this.headers[key] = value;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return { res, asResponse: res as unknown as Response };
}

describe('page and cursor meta', () => {
  it('computes totalPages', () => {
    expect(buildPageMeta({ page: 1, limit: 20, total: 240 })).toEqual({
      page: 1,
      limit: 20,
      total: 240,
      totalPages: 12,
    });
    expect(buildPageMeta({ page: 1, limit: 20, total: 241 }).totalPages).toBe(13);
  });

  it('handles empty results and bad limits safely', () => {
    expect(buildPageMeta({ page: 1, limit: 20, total: 0 }).totalPages).toBe(0);
    expect(buildPageMeta({ page: 1, limit: 0, total: 5 }).totalPages).toBe(5);
  });

  it('builds cursor meta', () => {
    expect(buildCursorMeta({ limit: 30, nextCursor: null })).toEqual({
      limit: 30,
      nextCursor: null,
    });
  });
});

describe('success responses', () => {
  it('omits meta when there is none', () => {
    expect(buildSuccessBody({ id: '1' })).toEqual({ success: true, data: { id: '1' } });
  });

  it('sends 200 by default and includes meta when given', () => {
    const { res, asResponse } = mockRes();
    const meta = buildPageMeta({ page: 1, limit: 10, total: 1 });
    sendSuccess(asResponse, [{ id: '1' }], { meta });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: [{ id: '1' }], meta });
  });

  it('sends 201 for created resources', () => {
    const { res, asResponse } = mockRes();
    sendCreated(asResponse, { id: '1' });
    expect(res.statusCode).toBe(201);
  });

  it('keeps null data inside the envelope', () => {
    const { res, asResponse } = mockRes();
    sendSuccess(asResponse, null);
    expect(res.body).toEqual({ success: true, data: null });
  });
});

describe('error responses', () => {
  it('matches the spec error shape', () => {
    const err = new AppError('VALIDATION_ERROR', {
      details: [{ field: 'email', issue: 'Invalid email' }],
    });
    expect(buildErrorBody(err, 'b7f3c1a2')).toEqual({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Some fields are invalid',
        details: [{ field: 'email', issue: 'Invalid email' }],
      },
      requestId: 'b7f3c1a2',
    });
  });

  it('leaves out details and retryAfter when absent', () => {
    const body = buildErrorBody(new AppError('NOT_FOUND'), 'r1');
    expect(body.error).toEqual({ code: 'NOT_FOUND', message: 'Resource not found' });
  });

  it('uses the code status and sets Retry-After when rate limited', () => {
    const { res, asResponse } = mockRes();
    sendError(asResponse, new AppError('RATE_LIMITED', { retryAfter: 45 }), 'r2');
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBe('45');
    expect(res.body).toMatchObject({ error: { code: 'RATE_LIMITED', retryAfter: 45 } });
  });

  it('never exposes the underlying cause', () => {
    const err = new AppError('INTERNAL_ERROR', { cause: new Error('mongo uri mongodb://u:pw@h') });
    const serialised = JSON.stringify(buildErrorBody(err, 'r3'));
    expect(serialised).not.toContain('mongodb://');
    expect(serialised).not.toContain('pw@h');
  });
});