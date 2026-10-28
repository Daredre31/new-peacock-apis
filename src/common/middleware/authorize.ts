import type { RequestHandler } from 'express';
import { can, type Permission } from '../../config/constants';
import { AppError } from '../errors/AppError';

/** Handlers carry a tag so a test can check that every route declares a permission or is public. */
export type GuardedHandler = RequestHandler & { permission?: Permission; isPublic?: true };

export function authorize(permission: Permission): GuardedHandler {
  const handler: RequestHandler = (req, _res, next) => {
    const user = req.user;
    if (!user) {
      next(new AppError('UNAUTHENTICATED'));
      return;
    }
    if (!can(user.role, permission)) {
      req.log.warn({ permission }, 'permission denied');
      next(new AppError('FORBIDDEN'));
      return;
    }
    next();
  };
  return Object.assign(handler, { permission });
}

/** For login, refresh, forgot and reset password, the webhook and health. Makes "public" a deliberate choice. */
export function publicRoute(): GuardedHandler {
  const handler: RequestHandler = (_req, _res, next) => {
    next();
  };
  return Object.assign(handler, { isPublic: true as const });
}