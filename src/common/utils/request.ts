import type { Request } from 'express';
import { AppError } from '../errors/AppError';

export function requireUser(req: Request): Express.AuthUser {
  if (!req.user) throw new AppError('UNAUTHENTICATED');
  return req.user;
}

export const contextOf = (req: Request): { ip: string; requestId: string } => ({
  ip: req.ip ?? 'unknown',
  requestId: req.id,
});