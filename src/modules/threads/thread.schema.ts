import { z } from 'zod';
import { paginationShape } from '../../common/utils/pagination';
import { PERMISSIONS } from '../../config/constants';
import type { OpenApiRegistry } from '../../openapi/registry';
import { THREAD_CATEGORIES, THREAD_STATUS, type ThreadStatus } from './thread.repository';

const objectId = z.string().regex(/^[a-f0-9]{24}$/);
const idParams = z.object({ id: objectId });
const statusValues = Object.values(THREAD_STATUS) as [ThreadStatus, ...ThreadStatus[]];
const iso = z.iso.datetime();

const createBody = z.object({
  studentId: objectId, category: z.enum(THREAD_CATEGORIES), subject: z.string().trim().min(3).max(150),
  body: z.string().trim().min(1).max(2000),
  /** TEACHER writes to one teacher (the class teacher unless teacherId is given). ADMIN writes to the school office. */
  to: z.enum(['TEACHER', 'ADMIN']), teacherId: objectId.optional(),
});
export const createThreadSchemas = { body: createBody };

export const listThreadsQuery = z.object({
  ...paginationShape, status: z.enum(statusValues).optional(), category: z.enum(THREAD_CATEGORIES).optional(), studentId: objectId.optional(),
});
export const listThreadsSchemas = { query: listThreadsQuery };

export const getThreadSchemas = {
  params: idParams,
  query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), cursor: z.string().max(60).optional() }),
};
const replyBody = z.object({ body: z.string().trim().min(1).max(2000) });
export const replySchemas = { params: idParams, body: replyBody };
const statusBody = z.object({ status: z.enum(['ANSWERED', 'CLOSED']) });
export const threadStatusSchemas = { params: idParams, body: statusBody };
export const childTeachersSchemas = { params: idParams };

const threadView = z.object({
  id: z.string(), category: z.enum(THREAD_CATEGORIES), subject: z.string(), status: z.enum(statusValues), audience: z.enum(['TEACHER', 'ADMIN']),
  student: z.object({ id: z.string(), name: z.string() }), parent: z.object({ id: z.string(), name: z.string() }),
  teacher: z.object({ id: z.string(), name: z.string() }).nullable(),
  lastMessageAt: iso, lastSenderRole: z.string(), messageCount: z.number().int(), createdAt: iso,
});

export function registerThreadOperations(registry: OpenApiRegistry): void {
  const tags = ['threads'];
  registry.register({ method: 'get', path: '/children/{id}/teachers', operationId: 'listChildTeachers', summary: "A linked child's class teacher and subject teachers, to choose who to write to", tags, roles: PERMISSIONS['children:read'], request: { params: idParams }, success: { status: 200, description: 'Teachers', data: z.array(z.object({ teacherId: z.string(), name: z.string(), classTeacher: z.boolean(), subjects: z.array(z.string()) })) }, errors: ['NOT_FOUND'] });
  registry.register({ method: 'post', path: '/threads', operationId: 'createThread', summary: 'A parent opens a conversation about a linked child with a teacher or the school office', tags, roles: PERMISSIONS['threads:create'], request: { body: createBody }, success: { status: 201, description: 'Created', data: threadView }, errors: ['NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'get', path: '/threads', operationId: 'listThreads', summary: 'Your conversations: parents their own, teachers those addressed to them, admins all', tags, roles: PERMISSIONS['threads:use'], request: { query: listThreadsQuery }, success: { status: 200, description: 'A page', data: z.array(threadView), paginated: true } });
  registry.register({ method: 'get', path: '/threads/{id}', operationId: 'getThread', summary: 'A conversation with its messages, oldest to newest. Send meta.nextCursor back as cursor for earlier ones', tags, roles: PERMISSIONS['threads:use'], request: { params: idParams, query: getThreadSchemas.query }, success: { status: 200, description: 'The conversation', data: z.object({ thread: threadView, nextCursor: z.string().nullable(), messages: z.array(z.object({ id: z.string(), senderId: z.string(), senderRole: z.string(), senderName: z.string(), body: z.string(), createdAt: iso })) }) }, errors: ['NOT_FOUND'] });
  registry.register({ method: 'post', path: '/threads/{id}/messages', operationId: 'replyToThread', summary: 'Reply. A parent reply reopens an answered conversation; a staff reply marks it answered. Closed conversations refuse replies', tags, roles: PERMISSIONS['threads:use'], request: { params: idParams, body: replyBody }, success: { status: 201, description: 'Sent', data: z.object({ id: z.string(), status: z.enum(statusValues) }) }, errors: ['NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'patch', path: '/threads/{id}/status', operationId: 'setThreadStatus', summary: 'Mark a conversation answered or closed (the teacher it is addressed to, or an admin)', tags, roles: PERMISSIONS['threads:status'], request: { params: idParams, body: statusBody }, success: { status: 200, description: 'Updated', data: threadView }, errors: ['NOT_FOUND', 'CONFLICT'] });
}