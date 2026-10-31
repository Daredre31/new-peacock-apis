import { z } from 'zod';
import { paginationShape } from '../../common/utils/pagination';
import { PERMISSIONS, USER_STATUS, type Permission, type UserStatus } from '../../config/constants';
import type { OpenApiRegistry } from '../../openapi/registry';
import { GENDERS, STAFF_TYPES, type StaffType } from './staff.model';

export interface StaffRouteConfig {
  type: StaffType;
  path: string;
  read: Permission;
  write: Permission;
  tag: string;
  singular: string;
  plural: string;
}

export const ADMIN_STAFF_CONFIG: StaffRouteConfig = {
  type: STAFF_TYPES.ADMIN,
  path: '/admins',
  read: 'admins:manage',
  write: 'admins:manage',
  tag: 'admins',
  singular: 'Admin',
  plural: 'Admins',
};

const objectId = z.string().regex(/^[a-f0-9]{24}$/);
const idParams = z.object({ id: objectId });
const name = z.string().trim().min(1).max(60);
const gender = z.enum(GENDERS);
const address = z.string().trim().min(1).max(200);
const dateOfBirth = z.iso.date();
const email = z.string().trim().min(3).max(254);
const phone = z.string().trim().min(7).max(30);

export const listStaffQuery = z.object({
  ...paginationShape,
  sort: z.enum(['name', '-name', 'staffNo', 'createdAt', '-createdAt']).default('name'),
  q: z.string().trim().min(1).max(50).optional(),
});
export const listStaffSchemas = { query: listStaffQuery };

const createStaffBody = z.object({
  firstName: name,
  lastName: name,
  gender: gender.optional(),
  dateOfBirth: dateOfBirth.optional(),
  address: address.optional(),
  email: email.optional(),
  phone: phone.optional(),
  /** TEMPORARY_PASSWORD returns a one-time password to hand over. EMAIL_INVITE emails a link and needs an email. */
  delivery: z.enum(['TEMPORARY_PASSWORD', 'EMAIL_INVITE']).default('TEMPORARY_PASSWORD'),
});
export const createStaffSchemas = { body: createStaffBody };

const updateStaffBody = z.object({
  firstName: name.optional(),
  lastName: name.optional(),
  gender: gender.optional(),
  dateOfBirth: dateOfBirth.optional(),
  address: address.optional(),
  email: email.optional(),
  phone: phone.optional(),
});
export const staffIdSchemas = { params: idParams };
export const updateStaffSchemas = { params: idParams, body: updateStaffBody };

const statusValues = Object.values(USER_STATUS) as [UserStatus, ...UserStatus[]];

export const staffViewSchema = z.object({
  id: z.string(),
  staffNo: z.string(),
  type: z.enum(Object.values(STAFF_TYPES) as [StaffType, ...StaffType[]]),
  firstName: z.string(),
  lastName: z.string(),
  gender: z.enum(GENDERS).nullable(),
  dateOfBirth: z.iso.date().nullable(),
  address: z.string().nullable(),
  email: z.string().nullable(),
  emailVerified: z.boolean(),
  phone: z.string().nullable(),
  status: z.enum(statusValues),
  mustChangePassword: z.boolean(),
  lastLoginAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

const createdSchema = z.object({
  account: staffViewSchema,
  /** Shown once, only for TEMPORARY_PASSWORD. It cannot be retrieved again. */
  temporaryPassword: z.string().nullable(),
  /** Only for EMAIL_INVITE: false means the email could not be sent, so reset the password instead. */
  inviteEmailSent: z.boolean().nullable(),
});

export function registerStaffOperations(registry: OpenApiRegistry, cfg: StaffRouteConfig): void {
  const tags = [cfg.tag];
  const readRoles = PERMISSIONS[cfg.read];
  const writeRoles = PERMISSIONS[cfg.write];
  const id = `{id}`;

  registry.register({ method: 'get', path: cfg.path, operationId: `list${cfg.plural}`, summary: `List ${cfg.plural.toLowerCase()}`, tags, roles: readRoles, request: { query: listStaffQuery }, success: { status: 200, description: 'A page', data: z.array(staffViewSchema), paginated: true } });
  registry.register({ method: 'post', path: cfg.path, operationId: `create${cfg.singular}`, summary: `Create a ${cfg.singular.toLowerCase()} account with a temporary password or an email invite`, tags, roles: writeRoles, request: { body: createStaffBody }, success: { status: 201, description: 'Created', data: createdSchema }, errors: ['CONFLICT'] });
  registry.register({ method: 'get', path: `${cfg.path}/${id}`, operationId: `get${cfg.singular}`, summary: `One ${cfg.singular.toLowerCase()}`, tags, roles: readRoles, request: { params: idParams }, success: { status: 200, description: 'Found', data: staffViewSchema }, errors: ['NOT_FOUND'] });
  registry.register({ method: 'patch', path: `${cfg.path}/${id}`, operationId: `update${cfg.singular}`, summary: `Update a ${cfg.singular.toLowerCase()} profile or contact`, tags, roles: writeRoles, request: { params: idParams, body: updateStaffBody }, success: { status: 200, description: 'Updated', data: staffViewSchema }, errors: ['NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'delete', path: `${cfg.path}/${id}`, operationId: `delete${cfg.singular}`, summary: `Remove a ${cfg.singular.toLowerCase()} (soft delete). Ends all their logins`, tags, roles: writeRoles, request: { params: idParams }, success: { status: 200, description: 'Removed', data: z.null() }, errors: ['NOT_FOUND'] });
}