import { z } from 'zod';
import { paginationShape } from '../../common/utils/pagination';
import { ROLES, USER_STATUS, type UserStatus } from '../../config/constants';
import type { OpenApiRegistry } from '../../openapi/registry';

const idParams = z.object({ id: z.string().regex(/^[a-f0-9]{24}$/) });
export const userActionSchemas = { params: idParams };

export const loginHistoryQuery = z.object({ ...paginationShape });
export const loginHistorySchemas = { params: idParams, query: loginHistoryQuery };

const statusValues = Object.values(USER_STATUS) as [UserStatus, ...UserStatus[]];
const statusResult = z.object({ id: z.string(), status: z.enum(statusValues) });

export function registerSecurityOperations(registry: OpenApiRegistry): void {
  const tags = ['security'];
  const roles = [ROLES.SUPER_ADMIN, ROLES.ADMIN];
  const action = (path: string, operationId: string, summary: string, data: z.ZodType) =>
    registry.register({
      method: 'post', path: `/users/{id}/${path}`, operationId, summary, tags, roles,
      request: { params: idParams },
      success: { status: 200, description: 'Done', data },
      errors: ['NOT_FOUND', 'FORBIDDEN'],
    });

  action('lock', 'lockUser', 'Lock an account and end all its logins. Admins can only act on non-admin accounts', statusResult);
  action('unlock', 'unlockUser', 'Unlock an account (also clears a login-attempt lockout)', statusResult);
  action('force-logout', 'forceLogoutUser', 'End every login this user has right now', statusResult);
  action('reset-password', 'resetUserPassword', 'Set a new temporary password, shown once. Ends all logins and forces a change', z.object({ temporaryPassword: z.string() }));

  registry.register({
    method: 'get', path: '/users/{id}/login-history', operationId: 'getLoginHistory',
    summary: 'Sign-in activity for an account, newest first', tags, roles: [ROLES.SUPER_ADMIN],
    request: { params: idParams, query: loginHistoryQuery },
    success: {
      status: 200, description: 'A page of events', paginated: true,
      data: z.array(z.object({ id: z.string(), event: z.string(), ip: z.string().nullable(), at: z.iso.datetime() })),
    },
    errors: ['NOT_FOUND'],
  });
}