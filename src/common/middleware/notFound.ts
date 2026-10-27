import type { RequestHandler } from 'express';
import { AppError } from '../errors/AppError';

export const notFound: RequestHandler = (_req, _res, next) => {
  next(new AppError('NOT_FOUND'));
};