import type { Response } from 'express';
import type { AppError, ErrorDetail } from '../errors/AppError';
import type { ErrorCode } from '../errors/errorCodes';

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** For feeds (notifications, messages) that page by cursor. */
export interface CursorMeta {
  limit: number;
  nextCursor: string | null;
}

export type ResponseMeta = PageMeta | CursorMeta;

export interface SuccessBody<T> {
  success: true;
  data: T;
  meta?: ResponseMeta;
}

export interface ErrorBody {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    details?: ErrorDetail[];
    retryAfter?: number;
  };
  requestId: string;
}

export function buildPageMeta(input: { page: number; limit: number; total: number }): PageMeta {
  const limit = Math.max(1, input.limit);
  return {
    page: input.page,
    limit,
    total: input.total,
    totalPages: Math.ceil(input.total / limit),
  };
}

export function buildCursorMeta(input: { limit: number; nextCursor: string | null }): CursorMeta {
  return { limit: input.limit, nextCursor: input.nextCursor };
}

export function buildSuccessBody<T>(data: T, meta?: ResponseMeta): SuccessBody<T> {
  return meta ? { success: true, data, meta } : { success: true, data };
}

export function buildErrorBody(error: AppError, requestId: string): ErrorBody {
  return {
    success: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details && { details: error.details }),
      ...(error.retryAfter !== undefined && { retryAfter: error.retryAfter }),
    },
    requestId,
  };
}

interface SendSuccessOptions {
  status?: number;
  meta?: ResponseMeta;
}

export function sendSuccess<T>(res: Response, data: T, options: SendSuccessOptions = {}): void {
  res.status(options.status ?? 200).json(buildSuccessBody(data, options.meta));
}

export function sendCreated<T>(res: Response, data: T): void {
  sendSuccess(res, data, { status: 201 });
}

export function sendError(res: Response, error: AppError, requestId: string): void {
  if (error.retryAfter !== undefined) {
    res.setHeader('Retry-After', String(error.retryAfter));
  }
  res.status(error.statusCode).json(buildErrorBody(error, requestId));
}