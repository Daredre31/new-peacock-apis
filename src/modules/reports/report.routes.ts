import { Router, type RequestHandler } from 'express';
import { authorize } from '../../common/middleware/authorize';
import { validate, type Validated } from '../../common/middleware/validate';
import { sendSuccess } from '../../common/utils/apiResponse';
import { contextOf, requireUser } from '../../common/utils/request';
import { createReportSchemas, reportIdSchemas } from './report.schema';
import type { ReportService } from './report.service';

export function createReportRouter(deps: { service: ReportService; authenticate: RequestHandler; limiter: RequestHandler }): Router {
  const { service, authenticate: auth, limiter } = deps;
  const router = Router();

  router.post('/reports/:type', auth, authorize('reports:generate'), limiter, validate(createReportSchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof createReportSchemas>;
    sendSuccess(res, await service.create(requireUser(req), params.type, body, contextOf(req)), { status: 202 });
  });

  router.get('/reports/:id', auth, authorize('reports:generate'), validate(reportIdSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof reportIdSchemas>;
    sendSuccess(res, await service.get(requireUser(req), params.id));
  });

  router.get('/reports/:id/download', auth, authorize('reports:generate'), validate(reportIdSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof reportIdSchemas>;
    const file = await service.download(requireUser(req), params.id, contextOf(req));
    res.status(200);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.setHeader('Content-Length', String(file.buffer.length));
    res.end(file.buffer);
  });

  return router;
}