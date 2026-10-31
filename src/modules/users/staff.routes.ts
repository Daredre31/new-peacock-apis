import { Router, type RequestHandler } from 'express';
import { AppError } from '../../common/errors/AppError';
import { authorize } from '../../common/middleware/authorize';
import { validate, type Validated } from '../../common/middleware/validate';
import type { ScopeService } from '../../common/scope/scope.service';
import { buildPageMeta, sendCreated, sendSuccess } from '../../common/utils/apiResponse';
import { contextOf, requireUser } from '../../common/utils/request';
import { ROLES } from '../../config/constants';
import { createStaffSchemas, listStaffSchemas, staffIdSchemas, updateStaffSchemas, type StaffRouteConfig } from './staff.schema';
import type { StaffService } from './staff.service';

const SELF_FIELDS = new Set(['address', 'phone']);

export function createStaffRouter(
  cfg: StaffRouteConfig,
  deps: { service: StaffService; authenticate: RequestHandler; scope: ScopeService },
): Router {
  const { service, authenticate: auth, scope } = deps;
  const router = Router();
  const one = `${cfg.path}/:id`;

  router.get(cfg.path, auth, authorize(cfg.list), validate(listStaffSchemas), async (req, res) => {
    const { query } = req.validated as Validated<typeof listStaffSchemas>;
    const { items, total } = await service.list(cfg.type, query);
    sendSuccess(res, items, { meta: buildPageMeta({ page: query.page, limit: query.limit, total }) });
  });

  router.post(cfg.path, auth, authorize(cfg.write), validate(createStaffSchemas), async (req, res) => {
    const { body } = req.validated as Validated<typeof createStaffSchemas>;
    sendCreated(res, await service.create(cfg.type, body, requireUser(req), contextOf(req)));
  });

  router.get(one, auth, authorize(cfg.read), validate(staffIdSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof staffIdSchemas>;
    if (cfg.selfService) scope.assertOwnUserOrAdmin(requireUser(req), params.id);
    sendSuccess(res, await service.get(cfg.type, params.id));
  });

  router.patch(one, auth, authorize(cfg.selfService ? cfg.read : cfg.write), validate(updateStaffSchemas), async (req, res) => {
    const user = requireUser(req);
    const { params, body } = req.validated as Validated<typeof updateStaffSchemas>;
    if (cfg.selfService && user.role === ROLES.TEACHER) {
      scope.assertOwnUserOrAdmin(user, params.id);
      if (Object.keys(body).some((key) => !SELF_FIELDS.has(key))) throw new AppError('FORBIDDEN');
    }
    sendSuccess(res, await service.update(cfg.type, params.id, body, user, contextOf(req)));
  });

  router.delete(one, auth, authorize(cfg.write), validate(staffIdSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof staffIdSchemas>;
    await service.remove(cfg.type, params.id, requireUser(req), contextOf(req));
    sendSuccess(res, null);
  });

  return router;
}