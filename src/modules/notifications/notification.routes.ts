import { Router, type RequestHandler } from 'express';
import { authorize } from '../../common/middleware/authorize';
import { validate, type Validated } from '../../common/middleware/validate';
import { buildCursorMeta, sendSuccess } from '../../common/utils/apiResponse';
import { requireUser } from '../../common/utils/request';
import { listNotificationsSchemas, markReadSchemas, preferencesSchemas } from './notification.schema';
import type { NotificationService } from './notification.service';

export function createNotificationRouter(deps: { service: NotificationService; authenticate: RequestHandler }): Router {
  const { service, authenticate: auth } = deps;
  const router = Router();
  const own = authorize('notifications:self');

  router.get('/notifications', auth, own, validate(listNotificationsSchemas), async (req, res) => {
    const { query } = req.validated as Validated<typeof listNotificationsSchemas>;
    const { items, nextCursor } = await service.list(requireUser(req).id, query);
    sendSuccess(res, items, { meta: buildCursorMeta({ limit: query.limit, nextCursor }) });
  });

  router.get('/notifications/unread-count', auth, own, validate({}), async (req, res) => {
    sendSuccess(res, { unread: await service.unreadCount(requireUser(req).id) });
  });

  router.post('/notifications/read', auth, own, validate(markReadSchemas), async (req, res) => {
    const { body } = req.validated as Validated<typeof markReadSchemas>;
    sendSuccess(res, await service.markRead(requireUser(req).id, body));
  });

  router.get('/notifications/preferences', auth, own, validate({}), async (req, res) => {
    sendSuccess(res, await service.getPreferences(requireUser(req).id));
  });

  router.put('/notifications/preferences', auth, own, validate(preferencesSchemas), async (req, res) => {
    const { body } = req.validated as Validated<typeof preferencesSchemas>;
    sendSuccess(res, await service.setPreferences(requireUser(req).id, body));
  });

  return router;
}