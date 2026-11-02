import { Router, type RequestHandler } from 'express';
import { authorize } from '../../common/middleware/authorize';
import { validate, type Validated } from '../../common/middleware/validate';
import { buildPageMeta, sendCreated, sendSuccess } from '../../common/utils/apiResponse';
import { contextOf, requireUser } from '../../common/utils/request';
import {
  announcementIdSchemas, createAnnouncementSchemas, listAnnouncementsSchemas, updateAnnouncementSchemas,
} from './announcement.schema';
import type { AnnouncementService } from './announcement.service';

export function createAnnouncementRouter(deps: { service: AnnouncementService; authenticate: RequestHandler }): Router {
  const { service: s, authenticate: auth } = deps;
  const router = Router();

  router.get('/announcements', auth, authorize('announcements:read'), validate(listAnnouncementsSchemas), async (req, res) => {
    const { query } = req.validated as Validated<typeof listAnnouncementsSchemas>;
    const { items, total } = await s.list(requireUser(req), query);
    sendSuccess(res, items, { meta: buildPageMeta({ page: query.page, limit: query.limit, total }) });
  });

  router.get('/announcements/unread-count', auth, authorize('announcements:read'), validate({}), async (req, res) => {
    sendSuccess(res, await s.unreadCount(requireUser(req)));
  });

  router.post('/announcements', auth, authorize('announcements:create'), validate(createAnnouncementSchemas), async (req, res) => {
    const { body } = req.validated as Validated<typeof createAnnouncementSchemas>;
    sendCreated(res, await s.create(requireUser(req), body, contextOf(req)));
  });

  router.patch('/announcements/:id', auth, authorize('announcements:update'), validate(updateAnnouncementSchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof updateAnnouncementSchemas>;
    sendSuccess(res, await s.update(requireUser(req), params.id, body, contextOf(req)));
  });

  router.delete('/announcements/:id', auth, authorize('announcements:update'), validate(announcementIdSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof announcementIdSchemas>;
    await s.remove(requireUser(req), params.id, contextOf(req));
    sendSuccess(res, null);
  });

  router.post('/announcements/:id/approve', auth, authorize('announcements:approve'), validate(announcementIdSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof announcementIdSchemas>;
    sendSuccess(res, await s.approve(requireUser(req), params.id, contextOf(req)));
  });

  router.post('/announcements/:id/read', auth, authorize('announcements:read'), validate(announcementIdSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof announcementIdSchemas>;
    sendSuccess(res, await s.markRead(requireUser(req), params.id));
  });

  return router;
}