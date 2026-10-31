import { z } from 'zod';
import { paginationShape } from '../../common/utils/pagination';
import { PERMISSIONS, ROLES, USER_STATUS, type UserStatus } from '../../config/constants';
import type { OpenApiRegistry } from '../../openapi/registry';
import { LINK_STATUS, RELATIONSHIPS, type LinkStatus } from './link.repository';

const objectId = z.string().regex(/^[a-f0-9]{24}$/);
const idParams = z.object({ id: objectId });
const name = z.string().trim().min(1).max(60);
const email = z.string().trim().min(3).max(254);
const phone = z.string().trim().min(7).max(30);
const relationship = z.enum(RELATIONSHIPS);
const userStatus = Object.values(USER_STATUS) as [UserStatus, ...UserStatus[]];
const linkStatus = Object.values(LINK_STATUS) as [LinkStatus, ...LinkStatus[]];

export const parentIdSchemas = { params: idParams };

export const listParentsQuery = z.object({
  ...paginationShape,
  sort: z.enum(['name', '-name', 'createdAt', '-createdAt']).default('name'),
  q: z.string().trim().min(1).max(50).optional(),
});
export const listParentsSchemas = { query: listParentsQuery };

const createBody = z.object({
  firstName: name,
  lastName: name,
  address: z.string().trim().min(1).max(200).optional(),
  email: email.optional(),
  phone: phone.optional(),
  delivery: z.enum(['TEMPORARY_PASSWORD', 'EMAIL_INVITE']).default('TEMPORARY_PASSWORD'),
});
export const createParentSchemas = { body: createBody };

const updateBody = z.object({
  firstName: name.optional(),
  lastName: name.optional(),
  address: z.string().trim().min(1).max(200).optional(),
  email: email.optional(),
  phone: phone.optional(),
});
export const updateParentSchemas = { params: idParams, body: updateBody };

const linkBody = z.object({ studentId: objectId, relationship });
export const linkParentSchemas = { params: idParams, body: linkBody };

export const claimSchemas = { body: z.object({ code: z.string().trim().min(8).max(12), relationship }) };
export const setLinkStatusSchemas = { params: idParams, body: z.object({ status: z.enum(['ACTIVE', 'REVOKED']) }) };

const listLinksQuery = z.object({ ...paginationShape, status: z.enum(linkStatus).optional(), parentId: objectId.optional(), studentId: objectId.optional() });
export const listLinksSchemas = { query: listLinksQuery };

export const claimCodeSchemas = { params: idParams };
export const childrenSchemas = {};

const parentView = z.object({
  id: z.string(), firstName: z.string(), lastName: z.string(), address: z.string().nullable(),
  email: z.string().nullable(), emailVerified: z.boolean(), phone: z.string().nullable(),
  status: z.enum(userStatus), mustChangePassword: z.boolean(), lastLoginAt: z.iso.datetime().nullable(), createdAt: z.iso.datetime(),
});
const linkView = z.object({
  id: z.string(), parentId: z.string(), parentName: z.string(), studentId: z.string(), studentName: z.string(),
  relationship, status: z.enum(linkStatus), createdAt: z.iso.datetime(),
});
const childView = z.object({
  id: z.string(), admissionNo: z.string(), firstName: z.string(), lastName: z.string(),
  status: z.string(), enrolment: z.object({ sessionId: z.string(), classArmId: z.string(), classArmName: z.string() }).nullable(),
}).passthrough();

export function registerParentOperations(registry: OpenApiRegistry): void {
  const tags = ['parents'];
  const manage = PERMISSIONS['parent-links:manage'];
  const writeRoles = PERMISSIONS['parents:write'];
  const page = (data: z.ZodType) => ({ status: 200, description: 'A page', data: z.array(data), paginated: true as const });

  registry.register({ method: 'get', path: '/parents', operationId: 'listParents', summary: 'List parents', tags, roles: writeRoles, request: { query: listParentsQuery }, success: page(parentView) });
  registry.register({ method: 'post', path: '/parents', operationId: 'createParent', summary: 'Create a parent account (phone, email or both) with a temporary password or an email invite', tags, roles: writeRoles, request: { body: createBody }, success: { status: 201, description: 'Created', data: z.object({ account: parentView, temporaryPassword: z.string().nullable(), inviteEmailSent: z.boolean().nullable() }) }, errors: ['CONFLICT'] });
  registry.register({ method: 'get', path: '/parents/{id}', operationId: 'getParent', summary: 'One parent (a parent sees only themselves)', tags, roles: PERMISSIONS['parents:read'], request: { params: idParams }, success: { status: 200, description: 'Found', data: parentView }, errors: ['NOT_FOUND'] });
  registry.register({ method: 'patch', path: '/parents/{id}', operationId: 'updateParent', summary: 'Update a parent. A parent may change only their own address and phone', tags, roles: PERMISSIONS['parents:read'], request: { params: idParams, body: updateBody }, success: { status: 200, description: 'Updated', data: parentView }, errors: ['NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'delete', path: '/parents/{id}', operationId: 'deleteParent', summary: 'Remove a parent (soft delete). Ends all their logins', tags, roles: writeRoles, request: { params: idParams }, success: { status: 200, description: 'Removed', data: z.null() }, errors: ['NOT_FOUND'] });

  registry.register({ method: 'post', path: '/parents/{id}/links', operationId: 'linkParentToStudent', summary: 'Link a parent to a student. Active at once', tags, roles: manage, request: { params: idParams, body: linkBody }, success: { status: 201, description: 'Linked', data: linkView }, errors: ['NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'get', path: '/links', operationId: 'listLinks', summary: 'List parent-student links. Filter status=PENDING to see claims waiting for approval', tags, roles: manage, request: { query: listLinksQuery }, success: page(linkView) });
  registry.register({ method: 'patch', path: '/links/{id}', operationId: 'setLinkStatus', summary: 'Approve a pending claim (ACTIVE) or revoke a link (REVOKED)', tags, roles: manage, request: { params: idParams, body: setLinkStatusSchemas.body }, success: { status: 200, description: 'Updated', data: linkView }, errors: ['NOT_FOUND'] });
  registry.register({ method: 'post', path: '/links/claim', operationId: 'claimChild', summary: 'Claim a child with a code from the school. Pending until an admin approves', tags, roles: [ROLES.PARENT], request: { body: claimSchemas.body }, success: { status: 201, description: 'Claim recorded', data: linkView }, errors: ['CONFLICT'] });
  registry.register({ method: 'post', path: '/students/{id}/claim-code', operationId: 'createClaimCode', summary: 'Make a one-time claim code for a student, to give to a parent. Shown once, valid 14 days', tags, roles: manage, request: { params: idParams }, success: { status: 201, description: 'Code created', data: z.object({ code: z.string(), expiresAt: z.iso.datetime() }) }, errors: ['NOT_FOUND'] });
  registry.register({ method: 'get', path: '/me/children', operationId: 'listMyChildren', summary: "The parent's own linked children", tags, roles: PERMISSIONS['children:read'], success: { status: 200, description: 'Children', data: z.array(childView) } });
}