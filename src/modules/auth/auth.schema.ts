import { z } from 'zod';
import { ROLES, type Role } from '../../config/constants';
import type { OpenApiRegistry } from '../../openapi/registry';

const roleValues = Object.values(ROLES) as [Role, ...Role[]];

// The password is never trimmed or changed, and no password rules apply at login.
export const loginBody = z.object({
  identifier: z.string().min(1).max(254),
  password: z.string().min(1).max(1024),
});

export const loginSchemas = { body: loginBody };

export const authUserSchema = z.object({
  id: z.string(),
  role: z.enum(roleValues),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  emailVerified: z.boolean(),
  phoneVerified: z.boolean(),
  mustChangePassword: z.boolean(),
});

const userEnvelope = z.object({ user: authUserSchema });

export function registerAuthOperations(registry: OpenApiRegistry): void {
  registry.register({
    method: 'post',
    path: '/auth/login',
    operationId: 'login',
    summary: 'Log in with email, phone, staff ID or registration number. Sets the cookies; no token is returned.',
    tags: ['auth'],
    request: { body: loginBody },
    success: { status: 200, description: 'Logged in', data: userEnvelope },
    errors: ['INVALID_CREDENTIALS', 'ACCOUNT_LOCKED', 'SERVICE_UNAVAILABLE'],
  });

  registry.register({
    method: 'post',
    path: '/auth/refresh',
    operationId: 'refreshSession',
    summary: 'Swap the refresh cookie for new cookies. 409 CONFLICT means retry once.',
    tags: ['auth'],
    success: { status: 200, description: 'Refreshed', data: userEnvelope },
    errors: ['UNAUTHENTICATED', 'CONFLICT', 'CSRF_INVALID', 'SERVICE_UNAVAILABLE'],
  });

  registry.register({
    method: 'post',
    path: '/auth/logout',
    operationId: 'logout',
    summary: 'End this login',
    tags: ['auth'],
    roles: roleValues,
    success: { status: 200, description: 'Logged out', data: z.null() },
  });

  registry.register({
    method: 'post',
    path: '/auth/logout-all',
    operationId: 'logoutAll',
    summary: 'End every login this user has',
    tags: ['auth'],
    roles: roleValues,
    success: { status: 200, description: 'Logged out everywhere', data: z.null() },
  });

  registry.register({
    method: 'get',
    path: '/auth/me',
    operationId: 'getCurrentUser',
    summary: 'The current user and role',
    tags: ['auth'],
    roles: roleValues,
    success: { status: 200, description: 'Current user', data: userEnvelope },
  });
}