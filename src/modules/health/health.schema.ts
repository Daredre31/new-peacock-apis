import { z } from 'zod';
import type { OpenApiRegistry } from '../../openapi/registry';

export const healthDataSchema = z.object({
  status: z.literal('ok'),
  uptimeSeconds: z.number().int().min(0),
});

export const readyDataSchema = z.object({ status: z.literal('ready') });

export function registerHealthOperations(registry: OpenApiRegistry): void {
  registry.register({
    method: 'get',
    path: '/health',
    operationId: 'getHealth',
    summary: 'Liveness: the process is up',
    tags: ['system'],
    success: { status: 200, description: 'Alive', data: healthDataSchema },
  });

  registry.register({
    method: 'get',
    path: '/ready',
    operationId: 'getReady',
    summary: 'Readiness: MongoDB and Redis both answer',
    tags: ['system'],
    success: { status: 200, description: 'Ready', data: readyDataSchema },
    errors: ['SERVICE_UNAVAILABLE'],
  });
}