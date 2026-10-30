import { z } from 'zod';
import { paginationShape } from '../../common/utils/pagination';
import { ALL_ROLES, ROLES } from '../../config/constants';
import type { OpenApiRegistry } from '../../openapi/registry';

const objectId = z.string().regex(/^[a-f0-9]{24}$/);
const sessionName = z.string().regex(/^\d{4}\/\d{4}$/);
const termName = z.string().trim().min(2).max(40);
const isoDate = z.iso.datetime();
const flag = z.enum(['true', 'false']).transform((value) => value === 'true');

// ---- sessions
export const listSessionsQuery = z.object({
  ...paginationShape,
  sort: z.enum(['-startDate', 'startDate', 'name', '-name']).default('-startDate'),
  q: z.string().trim().min(1).max(50).optional(),
  isCurrent: flag.optional(),
});
export const listSessionsSchemas = { query: listSessionsQuery };

const createSessionBody = z.object({ name: sessionName, startDate: isoDate, endDate: isoDate });
export const createSessionSchemas = { body: createSessionBody };

const updateSessionBody = z.object({
  name: sessionName.optional(),
  startDate: isoDate.optional(),
  endDate: isoDate.optional(),
});
const idParams = z.object({ id: objectId });
export const updateSessionSchemas = { params: idParams, body: updateSessionBody };
export const idParamsSchemas = { params: idParams };

// ---- terms
export const listTermsQuery = z.object({
  ...paginationShape,
  sort: z.enum(['startDate', '-startDate']).default('startDate'),
  sessionId: objectId.optional(),
  isCurrent: flag.optional(),
  locked: flag.optional(),
});
export const listTermsSchemas = { query: listTermsQuery };

const createTermBody = z.object({
  sessionId: objectId,
  name: termName,
  startDate: isoDate,
  endDate: isoDate,
});
export const createTermSchemas = { body: createTermBody };

const updateTermBody = z.object({
  name: termName.optional(),
  startDate: isoDate.optional(),
  endDate: isoDate.optional(),
});
export const updateTermSchemas = { params: idParams, body: updateTermBody };

// ---- responses
export const sessionViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  startDate: isoDate,
  endDate: isoDate,
  isCurrent: z.boolean(),
});
export const termViewSchema = sessionViewSchema.extend({ sessionId: z.string(), locked: z.boolean() });

export function registerSessionOperations(registry: OpenApiRegistry): void {
  const write = [ROLES.SUPER_ADMIN];
  const tags = ['academics'];

  registry.register({
    method: 'get', path: '/sessions', operationId: 'listSessions', summary: 'List academic sessions',
    tags, roles: ALL_ROLES, request: { query: listSessionsQuery },
    success: { status: 200, description: 'A page of sessions', data: z.array(sessionViewSchema), paginated: true },
  });
  registry.register({
    method: 'post', path: '/sessions', operationId: 'createSession', summary: 'Create a session, for example 2026/2027',
    tags, roles: write, request: { body: createSessionBody },
    success: { status: 201, description: 'Created', data: sessionViewSchema }, errors: ['CONFLICT'],
  });
  registry.register({
    method: 'patch', path: '/sessions/{id}', operationId: 'updateSession', summary: 'Change a session name or dates',
    tags, roles: write, request: { params: idParams, body: updateSessionBody },
    success: { status: 200, description: 'Updated', data: sessionViewSchema }, errors: ['NOT_FOUND', 'CONFLICT'],
  });

  registry.register({
    method: 'get', path: '/terms', operationId: 'listTerms', summary: 'List terms, filter by session or current',
    tags, roles: ALL_ROLES, request: { query: listTermsQuery },
    success: { status: 200, description: 'A page of terms', data: z.array(termViewSchema), paginated: true },
  });
  registry.register({
    method: 'post', path: '/terms', operationId: 'createTerm', summary: 'Create a term inside a session',
    tags, roles: write, request: { body: createTermBody },
    success: { status: 201, description: 'Created', data: termViewSchema }, errors: ['CONFLICT'],
  });
  registry.register({
    method: 'patch', path: '/terms/{id}', operationId: 'updateTerm', summary: 'Change a term name or dates (not while closed)',
    tags, roles: write, request: { params: idParams, body: updateTermBody },
    success: { status: 200, description: 'Updated', data: termViewSchema }, errors: ['NOT_FOUND', 'CONFLICT'],
  });
  for (const [action, operationId, summary] of [
    ['set-current', 'setCurrentTerm', 'Make this term, and its session, the current one'],
    ['close', 'closeTerm', 'Close a term. Its details can no longer be edited'],
    ['reopen', 'reopenTerm', 'Reopen a closed term'],
  ] as const) {
    registry.register({
      method: 'post', path: `/terms/{id}/${action}`, operationId, summary,
      tags, roles: write, request: { params: idParams },
      success: { status: 200, description: 'Done', data: termViewSchema }, errors: ['NOT_FOUND', 'CONFLICT'],
    });
  }
}