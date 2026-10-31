import { registerAuthOperations } from '../modules/auth/auth.schema';
import { registerHealthOperations } from '../modules/health/health.schema';
import { buildDocument, type OpenApiDocument } from './builder';
import { OpenApiRegistry } from './registry';
import { registerAuditOperations } from '../modules/audit/audit.schema';
import { registerSessionOperations } from '../modules/academics/session.schema';
import { registerStructureOperations } from '../modules/academics/structure.schema';
import { ADMIN_STAFF_CONFIG, registerStaffOperations } from '../modules/users/staff.schema';
import { registerSecurityOperations } from '../modules/users/security.schema';

/** Each phase adds its module's register function here. */
export function createOperationRegistry(): OpenApiRegistry {
  const registry = new OpenApiRegistry();
  registerHealthOperations(registry);
  registerAuthOperations(registry);
  registerAuditOperations(registry);
  registerSessionOperations(registry);
  registerStructureOperations(registry);
  registerStaffOperations(registry, ADMIN_STAFF_CONFIG);
  registerSecurityOperations(registry);
  return registry;
}

export function buildOpenApiDocument(): OpenApiDocument {
  return buildDocument(createOperationRegistry());
}