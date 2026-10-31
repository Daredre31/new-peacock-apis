import { Router, type RequestHandler } from 'express';
import { authorize } from '../../common/middleware/authorize';
import { validate, type Validated } from '../../common/middleware/validate';
import { buildPageMeta, sendSuccess } from '../../common/utils/apiResponse';
import { contextOf, requireUser } from '../../common/utils/request';
import { loginHistorySchemas, userActionSchemas } from './security.schema';
import type { SecurityService } from './security.service';

export function createSecurityRouter(deps: { service: SecurityService; authenticate: RequestHandler }): Router {
  const { service, authenticate: auth } = deps;
  const router = Router();
  const security = authorize('users:security');

  const action =
    (run: (id: string, actor: Express.AuthUser, ctx: ReturnType<typeof contextOf>) => Promise<unknown>): RequestHandler =>
    async (req, res) => {
      const { params } = req.validated as Validated<typeof userActionSchemas>;
      sendSuccess(res, await run(params.id, requireUser(req), contextOf(req)));
    };

  router.post('/users/:id/lock', auth, security, validate(userActionSchemas), action((id, a, c) => service.lock(id, a, c)));
  router.post('/users/:id/unlock', auth, security, validate(userActionSchemas), action((id, a, c) => service.unlock(id, a, c)));
  router.post('/users/:id/force-logout', auth, security, validate(userActionSchemas), action((id, a, c) => service.forceLogout(id, a, c)));
  router.post('/users/:id/reset-password', auth, security, validate(userActionSchemas), action((id, a, c) => service.resetPassword(id, a, c)));

  router.get('/users/:id/login-history', auth, authorize('users:login-history'), validate(loginHistorySchemas), async (req, res) => {
    const { params, query } = req.validated as Validated<typeof loginHistorySchemas>;
    const { items, total } = await service.loginHistory(params.id, query);
    sendSuccess(res, items, { meta: buildPageMeta({ page: query.page, limit: query.limit, total }) });
  });

  return router;
}