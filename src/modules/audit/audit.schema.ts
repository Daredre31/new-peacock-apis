import { z } from 'zod';
import { paginationShape } from '../../common/utils/pagination';
import { ROLES } from '../../config/constants';
import type { OpenApiRegistry } from '../../openapi/registry';

export const listAuditQuery = z.object({
  ...paginationShape,
  sort: z.enum(['-createdAt', 'createdAt']).default('-createdAt'),
  actorId: z.string().regex(/^[a-f0-9]{24}$/).optional(),
  action: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/).optional(),
  entityType: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/).optional(),
  entityId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});

export const listAuditSchemas = { query: listAuditQuery };

const jsonObject = z.record(z.string(), z.unknown()).nullable();

export const auditLogSchema = z.object({
  id: z.string(),
  action: z.string(),
  actorId: z.string().nullable(),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  ip: z.string().nullable(),
  requestId: z.string().nullable(),
  before: jsonObject,
  after: jsonObject,
  metadata: jsonObject,
  createdAt: z.iso.datetime(),
});

export function registerAuditOperations(registry: OpenApiRegistry): void {
  registry.register({
    method: 'get',
    path: '/audit-logs',
    operationId: 'listAuditLogs',
    summary: 'Audit log, read-only, filterable',
    tags: ['audit'],
    roles: [ROLES.SUPER_ADMIN],
    request: { query: listAuditQuery },
    success: { status: 200, description: 'A page of entries', data: z.array(auditLogSchema), paginated: true },
  });
}