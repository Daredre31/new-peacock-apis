import { Router, type RequestHandler } from 'express';
import { authorize } from '../../common/middleware/authorize';
import { validate, type Validated } from '../../common/middleware/validate';
import { buildPageMeta, sendCreated, sendSuccess } from '../../common/utils/apiResponse';
import { contextOf, requireUser } from '../../common/utils/request';
import {
  commentSchemas, createRequestSchemas, decideSchemas, escalateSchemas, listRequestsSchemas, requestIdSchemas, updateRequestSchemas,
} from './request.schema';
import type { RequestService } from './request.service';

export function createRequestRouter(deps: { service: RequestService; authenticate: RequestHandler }): Router {
  const { service: s, authenticate: auth } = deps;
  const router = Router();

  router.get('/requests', auth, authorize('requests:read'), validate(listRequestsSchemas), async (req, res) => {
    const { query } = req.validated as Validated<typeof listRequestsSchemas>;
    const { items, total } = await s.list(requireUser(req), query);
    sendSuccess(res, items, { meta: buildPageMeta({ page: query.page, limit: query.limit, total }) });
  });

  router.post('/requests', auth, authorize('requests:create'), validate(createRequestSchemas), async (req, res) => {
    const { body } = req.validated as Validated<typeof createRequestSchemas>;
    sendCreated(res, await s.create(requireUser(req), body, contextOf(req)));
  });

  router.get('/requests/:id', auth, authorize('requests:read'), validate(requestIdSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof requestIdSchemas>;
    sendSuccess(res, await s.get(requireUser(req), params.id));
  });

  router.patch('/requests/:id', auth, authorize('requests:create'), validate(updateRequestSchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof updateRequestSchemas>;
    sendSuccess(res, await s.update(requireUser(req), params.id, body, contextOf(req)));
  });

  router.post('/requests/:id/submit', auth, authorize('requests:submit'), validate(requestIdSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof requestIdSchemas>;
    sendSuccess(res, await s.submit(requireUser(req), params.id, contextOf(req)));
  });

  router.post('/requests/:id/return', auth, authorize('requests:return'), validate(commentSchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof commentSchemas>;
    sendSuccess(res, await s.returnToCreator(requireUser(req), params.id, body, contextOf(req)));
  });

  router.post('/requests/:id/escalate', auth, authorize('requests:escalate'), validate(escalateSchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof escalateSchemas>;
    sendSuccess(res, await s.escalate(requireUser(req), params.id, body, contextOf(req)));
  });

  router.post('/requests/:id/decide', auth, authorize('requests:decide'), validate(decideSchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof decideSchemas>;
    sendSuccess(res, await s.decide(requireUser(req), params.id, body, contextOf(req)));
  });

  router.post('/requests/:id/close', auth, authorize('requests:close'), validate(commentSchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof commentSchemas>;
    sendSuccess(res, await s.close(requireUser(req), params.id, body, contextOf(req)));
  });

  router.post('/requests/:id/comments', auth, authorize('requests:comment'), validate(commentSchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof commentSchemas>;
    sendSuccess(res, await s.comment(requireUser(req), params.id, body, contextOf(req)));
  });

  return router;
}