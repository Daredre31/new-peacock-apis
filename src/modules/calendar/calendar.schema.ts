import { z } from 'zod';
import { paginationShape } from '../../common/utils/pagination';
import { PERMISSIONS } from '../../config/constants';
import type { OpenApiRegistry } from '../../openapi/registry';

const objectId = z.string().regex(/^[a-f0-9]{24}$/);
const idParams = z.object({ id: objectId });
const iso = z.iso.datetime();
const title = z.string().trim().min(3).max(150);

const audience = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ALL') }),
  z.object({ type: z.literal('ROLES'), roles: z.array(z.enum(['ADMIN', 'TEACHER', 'PARENT', 'STUDENT'])).min(1).max(4) }),
  z.object({ type: z.literal('CLASS_ARMS'), classArmIds: z.array(objectId).min(1).max(50) }),
]);

const createBody = z.object({ title, description: z.string().trim().max(1000).nullable().optional(), startsAt: iso, endsAt: iso, audience });
const updateBody = z.object({
  title: title.optional(), description: z.string().trim().max(1000).nullable().optional(),
  startsAt: iso.optional(), endsAt: iso.optional(), audience: audience.optional(),
});

export const createEventSchemas = { body: createBody };
export const updateEventSchemas = { params: idParams, body: updateBody };
export const eventIdSchemas = { params: idParams };
export const listEventsQuery = z.object({ ...paginationShape, from: iso, to: iso });
export const listEventsSchemas = { query: listEventsQuery };
export const calendarQuery = z.object({ from: z.iso.date(), to: z.iso.date() });
export const calendarSchemas = { query: calendarQuery };

const eventView = z.object({
  id: z.string(), title: z.string(), description: z.string().nullable(), startsAt: iso, endsAt: iso, audience, createdAt: iso,
});
const calendarItem = z.object({
  id: z.string(), kind: z.enum(['EVENT', 'TERM', 'EXAM', 'TASK_DUE']), title: z.string(), start: iso, end: iso.nullable(),
  studentId: z.string().nullable(), detail: z.string().nullable(),
});

export function registerCalendarOperations(registry: OpenApiRegistry): void {
  const tags = ['calendar'];
  registry.register({ method: 'get', path: '/events', operationId: 'listEvents', summary: 'School events in a time window that you may see', tags, roles: PERMISSIONS['events:read'], request: { query: listEventsQuery }, success: { status: 200, description: 'A page', data: z.array(eventView), paginated: true } });
  registry.register({ method: 'post', path: '/events', operationId: 'createEvent', summary: 'Add an event for everyone, some roles, or some classes', tags, roles: PERMISSIONS['events:write'], request: { body: createBody }, success: { status: 201, description: 'Created', data: eventView } });
  registry.register({ method: 'patch', path: '/events/{id}', operationId: 'updateEvent', summary: 'Change an event', tags, roles: PERMISSIONS['events:write'], request: { params: idParams, body: updateBody }, success: { status: 200, description: 'Updated', data: eventView }, errors: ['NOT_FOUND'] });
  registry.register({ method: 'delete', path: '/events/{id}', operationId: 'deleteEvent', summary: 'Remove an event', tags, roles: PERMISSIONS['events:write'], request: { params: idParams }, success: { status: 200, description: 'Removed', data: z.null() }, errors: ['NOT_FOUND'] });
  registry.register({ method: 'get', path: '/calendar', operationId: 'getCalendar', summary: 'Everything in a date range that concerns you: events, term dates, exam windows and task deadlines. At most 62 days', tags, roles: PERMISSIONS['events:read'], request: { query: calendarQuery }, success: { status: 200, description: 'Items in time order', data: z.array(calendarItem) } });
}