import { Router, type RequestHandler } from 'express';
import { authorize } from '../../common/middleware/authorize';
import { validate, type Validated } from '../../common/middleware/validate';
import { buildPageMeta, sendCreated, sendSuccess } from '../../common/utils/apiResponse';
import { contextOf, requireUser } from '../../common/utils/request';
import type { FeeChargeService } from './feeCharge.service';
import {
  createFeeChargeSchemas, feeChargeIdSchemas, listFeeChargesSchemas, updateFeeChargeSchemas,
} from './feeCharge.schema';

export function createFeeChargeRouter(deps: { charges: FeeChargeService; authenticate: RequestHandler }): Router {
  const { charges, authenticate: auth } = deps;
  const router = Router();

  router.get('/fee-charges', auth, authorize('fee-charges:read'), validate(listFeeChargesSchemas), async (req, res) => {
    const { query } = req.validated as Validated<typeof listFeeChargesSchemas>;
    const { items, total } = await charges.list(query);
    sendSuccess(res, items, { meta: buildPageMeta({ page: query.page, limit: query.limit, total }) });
  });
  router.post('/fee-charges', auth, authorize('fee-charges:write'), validate(createFeeChargeSchemas), async (req, res) => {
    const { body } = req.validated as Validated<typeof createFeeChargeSchemas>;
    sendCreated(res, await charges.create(requireUser(req), body, contextOf(req)));
  });
  router.get('/fee-charges/:id', auth, authorize('fee-charges:read'), validate(feeChargeIdSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof feeChargeIdSchemas>;
    sendSuccess(res, await charges.get(params.id));
  });
  router.patch('/fee-charges/:id', auth, authorize('fee-charges:write'), validate(updateFeeChargeSchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof updateFeeChargeSchemas>;
    sendSuccess(res, await charges.update(requireUser(req), params.id, body, contextOf(req)));
  });
  router.delete('/fee-charges/:id', auth, authorize('fee-charges:write'), validate(feeChargeIdSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof feeChargeIdSchemas>;
    await charges.remove(requireUser(req), params.id, contextOf(req));
    sendSuccess(res, null);
  });
  router.post('/fee-charges/:id/approve', auth, authorize('fee-charges:approve'), validate(feeChargeIdSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof feeChargeIdSchemas>;
    sendSuccess(res, await charges.approve(requireUser(req), params.id, contextOf(req)));
  });
  router.post('/fee-charges/:id/revoke-approval', auth, authorize('fee-charges:approve'), validate(feeChargeIdSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof feeChargeIdSchemas>;
    sendSuccess(res, await charges.revokeApproval(requireUser(req), params.id, contextOf(req)));
  });
  router.post('/fee-charges/:id/issue', auth, authorize('fee-charges:issue'), validate(feeChargeIdSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof feeChargeIdSchemas>;
    sendSuccess(res, await charges.issue(requireUser(req), params.id, contextOf(req)));
  });

  return router;
}
