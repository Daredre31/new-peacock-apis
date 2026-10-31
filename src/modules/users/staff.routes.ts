import { Router, type RequestHandler } from 'express';
import { authorize } from '../../common/middleware/authorize';
import { validate, type Validated } from '../../common/middleware/validate';
import { buildPageMeta, sendCreated, sendSuccess } from '../../common/utils/apiResponse';
import { contextOf, requireUser } from '../../common/utils/request';
import {
  createStaffSchemas,
  listStaffSchemas,
  staffIdSchemas,
  updateStaffSchemas,
  type StaffRouteConfig,
} from './staff.schema';
import type { StaffService } from './staff.service';

export function createStaffRouter(
  cfg: StaffRouteConfig,
  deps: { service: StaffService; authenticate: RequestHandler },
): Router {
  const { service, authenticate: auth } = deps;
  const router = Router();
  const read = authorize(cfg.read);
  const write = authorize(cfg.write);
  const one = `${cfg.path}/:id`;

  router.get(cfg.path, auth, read, validate(listStaffSchemas), async (req, res) => {
    const { query } = req.validated as Validated<typeof listStaffSchemas>;
    const { items, total } = await service.list(cfg.type, query);
    sendSuccess(res, items, { meta: buildPageMeta({ page: query.page, limit: query.limit, total }) });
  });

  router.post(cfg.path, auth, write, validate(createStaffSchemas), async (req, res) => {
    const { body } = req.validated as Validated<typeof createStaffSchemas>;
    sendCreated(res, await service.create(cfg.type, body, requireUser(req), contextOf(req)));
  });

  router.get(one, auth, read, validate(staffIdSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof staffIdSchemas>;
    sendSuccess(res, await service.get(cfg.type, params.id));
  });

  router.patch(one, auth, write, validate(updateStaffSchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof updateStaffSchemas>;
    sendSuccess(res, await service.update(cfg.type, params.id, body, requireUser(req), contextOf(req)));
  });

  router.delete(one, auth, write, validate(staffIdSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof staffIdSchemas>;
    await service.remove(cfg.type, params.id, requireUser(req), contextOf(req));
    sendSuccess(res, null);
  });

  return router;
}