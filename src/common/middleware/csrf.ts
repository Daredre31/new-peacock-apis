import type { RequestHandler } from 'express';
import { AppError } from '../errors/AppError';
import { COOKIE_NAMES, setCsrfCookie } from '../../modules/auth/cookies';
import type { CsrfService } from '../../modules/auth/csrf.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function createCsrfMiddleware(csrf: CsrfService): RequestHandler {
  return (req, res, next) => {
    const cookies = req.cookies as Record<string, unknown> | undefined;
    const csrfCookie = cookies?.[COOKIE_NAMES.csrf];

    // CSRF only matters for requests the browser authenticated by itself, with cookies.
    // A request without either session cookie has nothing to forge: authenticate will reject it.
    const hasSession =
      typeof cookies?.[COOKIE_NAMES.access] === 'string' ||
      typeof cookies?.[COOKIE_NAMES.refresh] === 'string';

    if (SAFE_METHODS.has(req.method)) {
      // Self-healing: a logged-in browser that lost its CSRF cookie gets a new one on its next read.
      if (hasSession && !csrf.isValid(csrfCookie)) setCsrfCookie(res, csrf.generate());
      next();
      return;
    }

    if (!hasSession) {
      next();
      return;
    }

    if (!csrf.matches(csrfCookie, req.get('x-csrf-token'))) {
      next(new AppError('CSRF_INVALID'));
      return;
    }
    next();
  };
}