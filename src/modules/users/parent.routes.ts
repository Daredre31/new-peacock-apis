import { Router, type RequestHandler } from 'express';
import { AppError } from '../../common/errors/AppError';
import { authorize } from '../../common/middleware/authorize';
import { validate, type Validated } from '../../common/middleware/validate';
import type { ScopeService } from '../../common/scope/scope.service';
import { buildPageMeta, sendCreated, sendSuccess } from '../../common/utils/apiResponse';
import { contextOf, requireUser } from '../../common/utils/request';
import { ROLES } from '../../config/constants';
import type { LinkService } from './link.service';
import type { ParentService } from './parent.service';
import {
  claimCodeSchemas, claimSchemas, createParentSchemas, linkParentSchemas, listLinksSchemas, listParentsSchemas,
  parentIdSchemas, setLinkStatusSchemas, updateParentSchemas,
} from './parent.schema';

const SELF_FIELDS = new Set(['address', 'phone']);

export function createParentRouter(deps: {
  parentService: ParentService;
  linkService: LinkService;
  authenticate: RequestHandler;
  claimLimiter: RequestHandler;
  scope: ScopeService;
}): Router {
  const { parentService, linkService, authenticate: auth, claimLimiter, scope } = deps;
  const router = Router();

  router.get('/parents', auth, authorize('parents:write'), validate(listParentsSchemas), async (req, res) => {
    const { query } = req.validated as Validated<typeof listParentsSchemas>;
    const { items, total } = await parentService.list(query);
    sendSuccess(res, items, { meta: buildPageMeta({ page: query.page, limit: query.limit, total }) });
  });

  router.post('/parents', auth, authorize('parents:write'), validate(createParentSchemas), async (req, res) => {
    const { body } = req.validated as Validated<typeof createParentSchemas>;
    sendCreated(res, await parentService.create(body, requireUser(req), contextOf(req)));
  });

  router.get('/parents/:id', auth, authorize('parents:read'), validate(parentIdSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof parentIdSchemas>;
    scope.assertOwnUserOrAdmin(requireUser(req), params.id);
    sendSuccess(res, await parentService.get(params.id));
  });

  router.patch('/parents/:id', auth, authorize('parents:read'), validate(updateParentSchemas), async (req, res) => {
    const user = requireUser(req);
    const { params, body } = req.validated as Validated<typeof updateParentSchemas>;
    if (user.role === ROLES.PARENT) {
      scope.assertOwnUserOrAdmin(user, params.id);
      if (Object.keys(body).some((key) => !SELF_FIELDS.has(key))) throw new AppError('FORBIDDEN');
    }
    sendSuccess(res, await parentService.update(params.id, body, user, contextOf(req)));
  });

  router.delete('/parents/:id', auth, authorize('parents:write'), validate(parentIdSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof parentIdSchemas>;
    await parentService.remove(params.id, requireUser(req), contextOf(req));
    sendSuccess(res, null);
  });

  router.post('/parents/:id/links', auth, authorize('parent-links:manage'), validate(linkParentSchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof linkParentSchemas>;
    sendCreated(res, await linkService.link(params.id, body, requireUser(req), contextOf(req)));
  });

  router.get('/links', auth, authorize('parent-links:manage'), validate(listLinksSchemas), async (req, res) => {
    const { query } = req.validated as Validated<typeof listLinksSchemas>;
    const { items, total } = await linkService.list(query);
    sendSuccess(res, items, { meta: buildPageMeta({ page: query.page, limit: query.limit, total }) });
  });

  router.patch('/links/:id', auth, authorize('parent-links:manage'), validate(setLinkStatusSchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof setLinkStatusSchemas>;
    sendSuccess(res, await linkService.setStatus(params.id, body.status, requireUser(req), contextOf(req)));
  });

  router.post('/links/claim', auth, authorize('parent-links:claim'), claimLimiter, validate(claimSchemas), async (req, res) => {
    const { body } = req.validated as Validated<typeof claimSchemas>;
    sendCreated(res, await linkService.claim(requireUser(req).id, body, contextOf(req)));
  });

  router.post('/students/:id/claim-code', auth, authorize('parent-links:manage'), validate(claimCodeSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof claimCodeSchemas>;
    sendCreated(res, await linkService.createClaimCode(params.id, requireUser(req), contextOf(req)));
  });

  router.get('/me/children', auth, authorize('children:read'), validate({}), async (req, res) => {
    sendSuccess(res, await linkService.myChildren(requireUser(req).id));
  });

  return router;
}