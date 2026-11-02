import { z } from 'zod';
import { PERMISSIONS } from '../../config/constants';
import type { OpenApiRegistry } from '../../openapi/registry';

const objectId = z.string().regex(/^[a-f0-9]{24}$/);
const flag = z.enum(['true', 'false']).transform((value) => value === 'true');

export const listNotificationsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(60).optional(),
  unreadOnly: flag.optional(),
});
export const listNotificationsSchemas = { query: listNotificationsQuery };

export const markReadBody = z.object({ ids: z.array(objectId).min(1).max(100).optional(), all: z.literal(true).optional() });
export const markReadSchemas = { body: markReadBody };

export const preferencesBody = z.object({ inApp: z.boolean(), email: z.boolean() });
export const preferencesSchemas = { body: preferencesBody };

const notificationView = z.object({
  id: z.string(), type: z.string(), title: z.string(), body: z.string(),
  data: z.record(z.string(), z.string()).nullable(), read: z.boolean(), createdAt: z.iso.datetime(),
});

export function registerNotificationOperations(registry: OpenApiRegistry): void {
  const tags = ['notifications'];
  const roles = PERMISSIONS['notifications:self'];

  registry.register({ method: 'get', path: '/notifications', operationId: 'listNotifications', summary: 'Your notifications, newest first. Cursor paging: send meta.nextCursor back as cursor', tags, roles, request: { query: listNotificationsQuery }, success: { status: 200, description: 'A page', data: z.array(notificationView) } });
  registry.register({ method: 'get', path: '/notifications/unread-count', operationId: 'getUnreadNotificationCount', summary: 'How many unread notifications you have', tags, roles, success: { status: 200, description: 'Count', data: z.object({ unread: z.number().int() }) } });
  registry.register({ method: 'post', path: '/notifications/read', operationId: 'markNotificationsRead', summary: 'Mark some (ids) or all (all: true) notifications as read', tags, roles, request: { body: markReadBody }, success: { status: 200, description: 'Done', data: z.object({ updated: z.number().int() }) } });
  registry.register({ method: 'get', path: '/notifications/preferences', operationId: 'getNotificationPreferences', summary: 'Which channels you get notifications on', tags, roles, success: { status: 200, description: 'Preferences', data: preferencesBody } });
  registry.register({ method: 'put', path: '/notifications/preferences', operationId: 'setNotificationPreferences', summary: 'Turn in-app and email notifications on or off', tags, roles, request: { body: preferencesBody }, success: { status: 200, description: 'Saved', data: preferencesBody } });
}