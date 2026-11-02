import { z } from 'zod';
import { paginationShape } from '../../common/utils/pagination';
import { PERMISSIONS } from '../../config/constants';
import type { OpenApiRegistry } from '../../openapi/registry';
import { ANNOUNCEMENT_STATUS, type AnnouncementStatus } from './announcement.repository';

const objectId = z.string().regex(/^[a-f0-9]{24}$/);
const idParams = z.object({ id: objectId });
const statusValues = Object.values(ANNOUNCEMENT_STATUS) as [AnnouncementStatus, ...AnnouncementStatus[]];

const audience = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ALL') }),
  z.object({ type: z.literal('ROLES'), roles: z.array(z.enum(['ADMIN', 'TEACHER', 'PARENT', 'STUDENT'])).min(1).max(4) }),
  z.object({ type: z.literal('CLASS_ARMS'), classArmIds: z.array(objectId).min(1).max(50) }),
]);

const title = z.string().trim().min(3).max(150);
const body = z.string().trim().min(1).max(5000);

export const announcementIdSchemas = { params: idParams };

export const listAnnouncementsQuery = z.object({
  ...paginationShape,
  scope: z.enum(['feed', 'manage']).default('feed'),
  status: z.enum(statusValues).optional(),
  q: z.string().trim().min(1).max(50).optional(),
});
export const listAnnouncementsSchemas = { query: listAnnouncementsQuery };

const createBody = z.object({
  title, body, audience,
  /** Defaults to now. A future time schedules it. */
  publishAt: z.iso.datetime().optional(),
  expiresAt: z.iso.datetime().nullable().optional(),
  pinned: z.boolean().optional(),
});
export const createAnnouncementSchemas = { body: createBody };

const updateBody = z.object({
  title: title.optional(), body: body.optional(), audience: audience.optional(),
  publishAt: z.iso.datetime().optional(), expiresAt: z.iso.datetime().nullable().optional(), pinned: z.boolean().optional(),
});
export const updateAnnouncementSchemas = { params: idParams, body: updateBody };

const announcementView = z.object({
  id: z.string(), title: z.string(), body: z.string(), audience,
  publishAt: z.iso.datetime(), expiresAt: z.iso.datetime().nullable(), pinned: z.boolean(),
  status: z.enum(statusValues), authorId: z.string(), authorRole: z.string(), authorName: z.string().nullable(),
  /** Only in the feed: whether you have read it. */
  read: z.boolean().nullable(),
  createdAt: z.iso.datetime(),
});

export function registerAnnouncementOperations(registry: OpenApiRegistry): void {
  const tags = ['announcements'];
  registry.register({ method: 'get', path: '/announcements', operationId: 'listAnnouncements', summary: 'scope=feed: announcements for you, pinned first, with read markers. scope=manage: what you wrote (everything for admins)', tags, roles: PERMISSIONS['announcements:read'], request: { query: listAnnouncementsQuery }, success: { status: 200, description: 'A page', data: z.array(announcementView), paginated: true } });
  registry.register({ method: 'get', path: '/announcements/unread-count', operationId: 'getUnreadAnnouncementCount', summary: 'How many announcements you have not read', tags, roles: PERMISSIONS['announcements:read'], success: { status: 200, description: 'Count', data: z.object({ unread: z.number().int() }) } });
  registry.register({ method: 'post', path: '/announcements', operationId: 'createAnnouncement', summary: 'Post an announcement to everyone, some roles, or some class arms. Teachers post to their own classes only and need approval', tags, roles: PERMISSIONS['announcements:create'], request: { body: createBody }, success: { status: 201, description: 'Created', data: announcementView }, errors: ['NOT_FOUND'] });
  registry.register({ method: 'patch', path: '/announcements/{id}', operationId: 'updateAnnouncement', summary: 'Edit an announcement (the author, an admin or the super admin)', tags, roles: PERMISSIONS['announcements:update'], request: { params: idParams, body: updateBody }, success: { status: 200, description: 'Updated', data: announcementView }, errors: ['NOT_FOUND'] });
  registry.register({ method: 'delete', path: '/announcements/{id}', operationId: 'deleteAnnouncement', summary: 'Remove an announcement', tags, roles: PERMISSIONS['announcements:update'], request: { params: idParams }, success: { status: 200, description: 'Removed', data: z.null() }, errors: ['NOT_FOUND'] });
  registry.register({ method: 'post', path: '/announcements/{id}/approve', operationId: 'approveAnnouncement', summary: "Approve a teacher's post", tags, roles: PERMISSIONS['announcements:approve'], request: { params: idParams }, success: { status: 200, description: 'Approved', data: announcementView }, errors: ['NOT_FOUND'] });
  registry.register({ method: 'post', path: '/announcements/{id}/read', operationId: 'markAnnouncementRead', summary: 'Mark an announcement you can see as read', tags, roles: PERMISSIONS['announcements:read'], request: { params: idParams }, success: { status: 200, description: 'Done', data: z.object({ read: z.literal(true) }) }, errors: ['NOT_FOUND'] });
}