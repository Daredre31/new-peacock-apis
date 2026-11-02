import { z } from 'zod';
import { paginationShape } from '../../common/utils/pagination';
import {  PERMISSIONS } from '../../config/constants';
import type { OpenApiRegistry } from '../../openapi/registry';
import { REQUEST_TYPES } from './request.payloads';
import { DECISION_OUTCOMES, REQUEST_STATUS, STEP_ACTIONS } from './request.rules';

const objectId = z.string().regex(/^[a-f0-9]{24}$/);
const idParams = z.object({ id: objectId });
const flag = z.enum(['true', 'false']).transform((value) => value === 'true');
const statuses = Object.values(REQUEST_STATUS) as [string, ...string[]];
const comment = z.string().trim().min(1).max(2000);

export const requestIdSchemas = { params: idParams };

export const listRequestsQuery = z.object({
  ...paginationShape,
  sort: z.enum(['-updatedAt', '-createdAt']).default('-updatedAt'),
  status: z.enum(REQUEST_STATUS_VALUES()).optional(),
  type: z.enum(REQUEST_TYPES).optional(),
  mine: flag.optional(),
  /** Only requests waiting on you: admins see new ones, the super admin escalated ones, creators returned ones. */
  needsAction: flag.optional(),
  studentId: objectId.optional(),
});
export const listRequestsSchemas = { query: listRequestsQuery };

function REQUEST_STATUS_VALUES() {
  return Object.values(REQUEST_STATUS) as [(typeof REQUEST_STATUS)[keyof typeof REQUEST_STATUS], ...(typeof REQUEST_STATUS)[keyof typeof REQUEST_STATUS][]];
}

/** The payload is checked per type. See request.payloads.ts for the fields of each type. */
const createBody = z.object({ type: z.enum(REQUEST_TYPES), studentId: objectId.optional(), payload: z.record(z.string(), z.unknown()) });
export const createRequestSchemas = { body: createBody };

const updateBody = z.object({ studentId: objectId.optional(), payload: z.record(z.string(), z.unknown()) });
export const updateRequestSchemas = { params: idParams, body: updateBody };

const commentBody = z.object({ comment });
export const commentSchemas = { params: idParams, body: commentBody };
const escalateBody = z.object({ comment: z.string().trim().max(2000).optional() });
export const escalateSchemas = { params: idParams, body: escalateBody };
const decideBody = z.object({ outcome: z.enum(DECISION_OUTCOMES), comment });
export const decideSchemas = { params: idParams, body: decideBody };

const person = z.object({ id: z.string(), name: z.string(), role: z.string() }).nullable();
const requestView = z.object({
  id: z.string(), reference: z.string(), type: z.enum(REQUEST_TYPES), status: z.enum(statuses as [string, ...string[]]),
  title: z.string(), createdBy: person, studentId: z.string().nullable(), studentName: z.string().nullable(),
  workingDays: z.number().int().nullable(),
  decision: z.object({ outcome: z.enum(DECISION_OUTCOMES), decidedBy: person, at: z.iso.datetime() }).nullable(),
  allowedActions: z.array(z.enum(['EDIT', 'SUBMIT', 'COMMENT', 'RETURN', 'ESCALATE', 'CLOSE', 'DECIDE'])),
  payload: z.record(z.string(), z.unknown()).nullable(),
  steps: z.array(z.object({
    action: z.enum(STEP_ACTIONS), comment: z.string().nullable(), fromStatus: z.string().nullable(),
    toStatus: z.string(), at: z.iso.datetime(), actor: person,
  })).nullable(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});

export function registerRequestOperations(registry: OpenApiRegistry): void {
  const tags = ['requests'];
  const post = (path: string, operationId: string, summary: string, permission: keyof typeof PERMISSIONS, req: { params: z.ZodObject; body?: z.ZodObject }, errors: ('NOT_FOUND' | 'REQUEST_INVALID_TRANSITION')[] = ['NOT_FOUND', 'REQUEST_INVALID_TRANSITION']) =>
    registry.register({ method: 'post', path, operationId, summary, tags, roles: PERMISSIONS[permission], request: req, success: { status: 200, description: 'The updated request', data: requestView }, errors });

  registry.register({ method: 'get', path: '/requests', operationId: 'listRequests', summary: 'List requests you can see. Use needsAction=true for your to-do list', tags, roles: PERMISSIONS['requests:read'], request: { query: listRequestsQuery }, success: { status: 200, description: 'A page', data: z.array(requestView), paginated: true } });
  registry.register({ method: 'post', path: '/requests', operationId: 'createRequest', summary: 'Create a draft. payload fields depend on type; see request.payloads.ts. Teachers: reviews, incidents, resources, leave. Admins: leave, waivers, refunds, result publication, transfers. Parents: complaints, suggestions', tags, roles: PERMISSIONS['requests:create'], request: { body: createBody }, success: { status: 201, description: 'Created', data: requestView }, errors: ['NOT_FOUND'] });
  registry.register({ method: 'get', path: '/requests/{id}', operationId: 'getRequest', summary: 'One request with its full step history and the actions you may take', tags, roles: PERMISSIONS['requests:read'], request: { params: idParams }, success: { status: 200, description: 'Found', data: requestView }, errors: ['NOT_FOUND'] });
  registry.register({ method: 'patch', path: '/requests/{id}', operationId: 'updateRequest', summary: 'Edit a draft, or a returned request, before resubmitting', tags, roles: PERMISSIONS['requests:create'], request: { params: idParams, body: updateBody }, success: { status: 200, description: 'Updated', data: requestView }, errors: ['NOT_FOUND', 'REQUEST_INVALID_TRANSITION'] });
  post('/requests/{id}/submit', 'submitRequest', 'Send to the next level. Admin-created requests go straight to the super admin', 'requests:submit', { params: idParams });
  post('/requests/{id}/return', 'returnRequest', 'Send back to the creator with a comment', 'requests:return', { params: idParams, body: commentBody });
  post('/requests/{id}/escalate', 'escalateRequest', 'Escalate to the super admin', 'requests:escalate', { params: idParams, body: escalateBody });
  post('/requests/{id}/decide', 'decideRequest', 'Approve, reject or note, with a comment. The super admin decides escalated requests; an admin decides short leave directly', 'requests:decide', { params: idParams, body: decideBody });
  post('/requests/{id}/close', 'closeRequest', 'Close without a decision, with a reason', 'requests:close', { params: idParams, body: commentBody });
  post('/requests/{id}/comments', 'commentOnRequest', 'Add a comment', 'requests:comment', { params: idParams, body: commentBody });
  
}