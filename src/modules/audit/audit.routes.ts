import { Router, type RequestHandler } from 'express';
import { authorize } from '../../common/middleware/authorize';
import { validate, type Validated } from '../../common/middleware/validate';
import { buildPageMeta, sendSuccess } from '../../common/utils/apiResponse';
import { listAuditSchemas } from './audit.schema';
import type { AuditService } from './audit.service';

export function createAuditRouter(deps: { service: AuditService; authenticate: RequestHandler }): Router {
  const router = Router();

  const list: RequestHandler = async (req, res) => {
    const { query } = req.validated as Validated<typeof listAuditSchemas>;
    const { from, to, ...rest } = query;

    const { items, total } = await deps.service.list({
      ...rest,
      ...(from && { from: new Date(from) }),
      ...(to && { to: new Date(to) }),
    });
    sendSuccess(res, items, { meta: buildPageMeta({ page: query.page, limit: query.limit, total }) });
  };

  router.get('/', deps.authenticate, authorize('audit:read'), validate(listAuditSchemas), list);
  return router;
}