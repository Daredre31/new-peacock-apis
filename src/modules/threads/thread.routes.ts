import { Router, type RequestHandler } from 'express';
import { authorize } from '../../common/middleware/authorize';
import { validate, type Validated } from '../../common/middleware/validate';
import { buildCursorMeta, buildPageMeta, sendCreated, sendSuccess } from '../../common/utils/apiResponse';
import { contextOf, requireUser } from '../../common/utils/request';
import {
  childTeachersSchemas, createThreadSchemas, getThreadSchemas, listThreadsSchemas, replySchemas, threadStatusSchemas,
} from './thread.schema';
import type { ThreadService } from './thread.service';

export function createThreadRouter(deps: { service: ThreadService; authenticate: RequestHandler; limiter: RequestHandler }): Router {
  const { service: s, authenticate: auth, limiter } = deps;
  const router = Router();

  router.get('/children/:id/teachers', auth, authorize('children:read'), validate(childTeachersSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof childTeachersSchemas>;
    sendSuccess(res, await s.teachersOfChild(requireUser(req), params.id));
  });

  router.post('/threads', auth, authorize('threads:create'), limiter, validate(createThreadSchemas), async (req, res) => {
    const { body } = req.validated as Validated<typeof createThreadSchemas>;
    sendCreated(res, await s.create(requireUser(req), body, contextOf(req)));
  });

  router.get('/threads', auth, authorize('threads:use'), validate(listThreadsSchemas), async (req, res) => {
    const { query } = req.validated as Validated<typeof listThreadsSchemas>;
    const { items, total } = await s.list(requireUser(req), query);
    sendSuccess(res, items, { meta: buildPageMeta({ page: query.page, limit: query.limit, total }) });
  });

  router.get('/threads/:id', auth, authorize('threads:use'), validate(getThreadSchemas), async (req, res) => {
    const { params, query } = req.validated as Validated<typeof getThreadSchemas>;
    const { thread, messages, nextCursor } = await s.get(requireUser(req), params.id, query);
    sendSuccess(res, { thread, messages, nextCursor }, { meta: buildCursorMeta({ limit: query.limit, nextCursor }) });
  });

  router.post('/threads/:id/messages', auth, authorize('threads:use'), limiter, validate(replySchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof replySchemas>;
    sendCreated(res, await s.reply(requireUser(req), params.id, body, contextOf(req)));
  });

  router.patch('/threads/:id/status', auth, authorize('threads:status'), validate(threadStatusSchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof threadStatusSchemas>;
    sendSuccess(res, await s.setStatus(requireUser(req), params.id, body.status, contextOf(req)));
  });

  return router;
}