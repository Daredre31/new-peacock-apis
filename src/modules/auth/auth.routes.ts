import { Router, type RequestHandler } from 'express';
import { authorize, publicRoute } from '../../common/middleware/authorize';
import { validate } from '../../common/middleware/validate';
import { loginSchemas } from './auth.schema';
import type { createAuthController } from './auth.controller';

export interface AuthRouterDeps {
  controller: ReturnType<typeof createAuthController>;
  authenticateAllowingPasswordChange: RequestHandler;
  loginLimiter: RequestHandler;
}

export function createAuthRouter(deps: AuthRouterDeps): Router {
  const { controller, authenticateAllowingPasswordChange: authenticated, loginLimiter } = deps;
  const router = Router();
  const none = validate({});

  // The limiter runs before validation, so malformed attempts count too.
  router.post('/login', publicRoute(), loginLimiter, validate(loginSchemas), controller.login);
  router.post('/refresh', publicRoute(), none, controller.refresh);

  // These stay reachable while a password change is pending, so the person can log out.
  router.post('/logout', authenticated, authorize('session:self'), none, controller.logout);
  router.post('/logout-all', authenticated, authorize('session:self'), none, controller.logoutAll);
  router.get('/me', authenticated, authorize('session:self'), none, controller.me);

  return router;
}