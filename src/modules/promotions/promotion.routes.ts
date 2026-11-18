import { Router, type RequestHandler } from 'express';
import { authorize } from '../../common/middleware/authorize';
import { validate, type Validated } from '../../common/middleware/validate';
import { sendSuccess } from '../../common/utils/apiResponse';
import { contextOf, requireUser } from '../../common/utils/request';
import { commitSchemas, previewSchemas } from './promotion.schema';
import type { PromotionService } from './promotion.service';

export function createPromotionRouter(deps: { service: PromotionService; authenticate: RequestHandler }): Router {
  const { service, authenticate: auth } = deps;
  const router = Router();

  router.get('/promotions/preview', auth, authorize('promotions:preview'), validate(previewSchemas), async (req, res) => {
    const { query } = req.validated as Validated<typeof previewSchemas>;
    sendSuccess(res, await service.preview(query));
  });

  router.post('/promotions/commit', auth, authorize('promotions:commit'), validate(commitSchemas), async (req, res) => {
    const { body } = req.validated as Validated<typeof commitSchemas>;
    sendSuccess(res, await service.commit(body, requireUser(req), contextOf(req)));
  });

  return router;
}
