import { registerHealthOperations } from '../modules/health/health.schema';
import { buildDocument, type OpenApiDocument } from './builder';
import { OpenApiRegistry } from './registry';

/** Each phase adds its module's register function here. */
export function createOperationRegistry(): OpenApiRegistry {
  const registry = new OpenApiRegistry();
  registerHealthOperations(registry);
  return registry;
}

export function buildOpenApiDocument(): OpenApiDocument {
  return buildDocument(createOperationRegistry());
}