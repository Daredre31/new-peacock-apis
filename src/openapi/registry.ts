import type { z } from 'zod';
import type { ErrorCode } from '../common/errors/errorCodes';
import type { Role } from '../config/constants';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface OperationSpec {
  method: HttpMethod;
  /** Relative to /api/v1, in OpenAPI style, for example /students/{id}. */
  path: string;
  operationId: string;
  summary: string;
  tags: string[];
  /** Roles allowed. Omit for public routes. Published as x-roles. */
  roles?: readonly Role[];
  request?: { params?: z.ZodObject; query?: z.ZodObject; body?: z.ZodObject };
  success: { status: number; description: string; data: z.ZodType; paginated?: boolean };
  /** Route-specific errors. Common ones are added automatically by the builder. */
  errors?: ErrorCode[];
  upload?: boolean;
}

export class OpenApiRegistry {
  private readonly operations: OperationSpec[] = [];

  register(spec: OperationSpec): void {
    const duplicate = this.operations.find(
      (op) => op.operationId === spec.operationId || (op.method === spec.method && op.path === spec.path),
    );
    if (duplicate) {
      throw new Error(`Duplicate OpenAPI operation: ${spec.method.toUpperCase()} ${spec.path} (${spec.operationId})`);
    }
    this.operations.push(spec);
  }

  list(): readonly OperationSpec[] {
    return this.operations;
  }
}