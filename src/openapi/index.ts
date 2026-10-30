import { registerAuthOperations } from '../modules/auth/auth.schema';
import { registerHealthOperations } from '../modules/health/health.schema';
import { buildDocument, type OpenApiDocument } from './builder';
import { OpenApiRegistry } from './registry';
import { registerAuditOperations } from '../modules/audit/audit.schema';

/** Each phase adds its module's register function here. */
export function createOperationRegistry(): OpenApiRegistry {
  const registry = new OpenApiRegistry();
  registerHealthOperations(registry);
  registerAuthOperations(registry);
  registerAuditOperations(registry);
  return registry;
}

export function buildOpenApiDocument(): OpenApiDocument {
  return buildDocument(createOperationRegistry());
}