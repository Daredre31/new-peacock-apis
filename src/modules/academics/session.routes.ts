import { Router, type RequestHandler } from 'express';
import { authorize } from '../../common/middleware/authorize';
import { validate } from '../../common/middleware/validate';
import { createSessionController } from './session.controller';
import {
  createSessionSchemas,
  createTermSchemas,
  idParamsSchemas,
  listSessionsSchemas,
  listTermsSchemas,
  updateSessionSchemas,
  updateTermSchemas,
} from './session.schema';
import type { SessionService } from './session.service';

export function createSessionRouter(deps: { service: SessionService; authenticate: RequestHandler }): Router {
  const { authenticate: auth } = deps;
  const c = createSessionController(deps.service);
  const router = Router();

  router.get('/sessions', auth, authorize('sessions:read'), validate(listSessionsSchemas), c.listSessions);
  router.post('/sessions', auth, authorize('sessions:write'), validate(createSessionSchemas), c.createSession);
  router.patch('/sessions/:id', auth, authorize('sessions:write'), validate(updateSessionSchemas), c.updateSession);

  router.get('/terms', auth, authorize('sessions:read'), validate(listTermsSchemas), c.listTerms);
  router.post('/terms', auth, authorize('sessions:write'), validate(createTermSchemas), c.createTerm);
  router.patch('/terms/:id', auth, authorize('sessions:write'), validate(updateTermSchemas), c.updateTerm);
  router.post('/terms/:id/set-current', auth, authorize('sessions:write'), validate(idParamsSchemas), c.setCurrentTerm);
  router.post('/terms/:id/close', auth, authorize('sessions:write'), validate(idParamsSchemas), c.closeTerm);
  router.post('/terms/:id/reopen', auth, authorize('sessions:write'), validate(idParamsSchemas), c.reopenTerm);

  return router;
}