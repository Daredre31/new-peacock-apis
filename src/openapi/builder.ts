import { z } from 'zod';
import { ERROR_CODES, type ErrorCode } from '../common/errors/errorCodes';
import type { Role } from '../config/constants';
import { OPENAPI_INFO } from './info';
import type { OpenApiRegistry, OperationSpec } from './registry';

export type JsonSchema = Record<string, unknown>;

export interface ParameterObject {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  schema: JsonSchema;
}

export interface ResponseObject {
  description: string;
  content: { 'application/json': { schema: JsonSchema } };
}

export interface OperationObject {
  operationId: string;
  summary: string;
  tags: string[];
  'x-roles': Role[];
  parameters?: ParameterObject[];
  requestBody?: { required: true; content: Record<string, { schema: JsonSchema }> };
  responses: Record<string, ResponseObject>;
}

export interface OpenApiDocument {
  openapi: '3.1.0';
  info: { title: string; version: string; description: string };
  servers: { url: string }[];
  tags: { name: string }[];
  paths: Record<string, Record<string, OperationObject>>;
  components: { schemas: Record<string, JsonSchema> };
}

const ErrorResponse = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.enum(Object.keys(ERROR_CODES) as [ErrorCode, ...ErrorCode[]]),
    message: z.string(),
    details: z.array(z.object({ field: z.string(), issue: z.string() })).optional(),
    retryAfter: z.number().int().optional(),
  }),
  requestId: z.string(),
});

const PageMeta = z.object({
  page: z.number().int().min(1),
  limit: z.number().int().min(1),
  total: z.number().int().min(0),
  totalPages: z.number().int().min(0),
});

/**
 * Zod to JSON Schema. Unsupported types (z.date(), z.function() ...) throw, so a
 * schema that cannot be described fails the build instead of silently becoming "any".
 * Use z.iso.datetime() for dates. Schemas must be self-contained: no $defs or $ref.
 */
function toSchema(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io }) as JsonSchema;
  delete json.$schema;

  if ('$defs' in json || JSON.stringify(json).includes('"$ref"')) {
    throw new Error('OpenAPI schemas must be self-contained (no recursive or shared $defs yet).');
  }
  return json;
}

function toParameters(
  schema: z.ZodObject | undefined,
  location: 'path' | 'query',
): ParameterObject[] {
  if (!schema) return [];
  const json = toSchema(schema, 'input');
  const properties = (json.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((json.required ?? []) as string[]);

  return Object.entries(properties).map(([name, propSchema]) => ({
    name,
    in: location,
    required: location === 'path' ? true : required.has(name),
    schema: propSchema,
  }));
}

/** Every route can return these, because validate() rejects unknown fields everywhere. */
function errorCodesFor(op: OperationSpec): ErrorCode[] {
  const codes = new Set<ErrorCode>(['VALIDATION_ERROR', 'RATE_LIMITED', 'INTERNAL_ERROR']);
  for (const code of op.errors ?? []) codes.add(code);

  const authenticated = op.roles !== undefined && op.roles.length > 0;
  if (authenticated) {
    for (const code of ['UNAUTHENTICATED', 'TOKEN_EXPIRED', 'FORBIDDEN', 'PASSWORD_CHANGE_REQUIRED'] as const) {
      codes.add(code);
    }
    if (op.method !== 'get') codes.add('CSRF_INVALID');
  }
  return [...codes].sort();
}

function buildOperation(op: OperationSpec): OperationObject {
  const pathParams = toParameters(op.request?.params, 'path');

  // The {placeholders} in the path and the params schema must describe the same names.
  const placeholders = [...op.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').sort();
  const declared = pathParams.map((p) => p.name).sort();
  if (JSON.stringify(placeholders) !== JSON.stringify(declared)) {
    throw new Error(`Path parameters of ${op.operationId} do not match ${op.path}`);
  }

  const parameters = [...pathParams, ...toParameters(op.request?.query, 'query')];
  const { success } = op;

  const envelope: JsonSchema = {
    type: 'object',
    required: success.paginated ? ['success', 'data', 'meta'] : ['success', 'data'],
    properties: {
      success: { const: true },
      data: toSchema(success.data, 'output'),
      ...(success.paginated && { meta: { $ref: '#/components/schemas/PageMeta' } }),
    },
  };

  const responses: Record<string, ResponseObject> = {
    [String(success.status)]: {
      description: success.description,
      content: { 'application/json': { schema: envelope } },
    },
  };

  const byStatus = new Map<number, ErrorCode[]>();
  for (const code of errorCodesFor(op)) {
    const status = ERROR_CODES[code].status;
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  for (const [status, codes] of [...byStatus].sort(([a], [b]) => a - b)) {
    responses[String(status)] = {
      description: codes.join(' | '),
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
    };
  }

  return {
    operationId: op.operationId,
    summary: op.summary,
    tags: op.tags,
    // Public routes publish an empty list.
    'x-roles': [...(op.roles ?? [])],
    ...(parameters.length > 0 && { parameters }),
    ...(op.request?.body && {
      requestBody: {
        required: true as const,
        content: { 'application/json': { schema: toSchema(op.request.body, 'input') } },
      },
    }),
        ...(op.upload && {
      requestBody: {
        required: true as const,
        content: {
          'multipart/form-data': {
            schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } },
          },
        },
      },
    }),
    responses,
  };
}

export function buildDocument(registry: OpenApiRegistry): OpenApiDocument {
  // Sorted, so the generated file only changes when the contract does.
  const operations = [...registry.list()].sort(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
  );

  const paths: OpenApiDocument['paths'] = {};
  for (const op of operations) {
    paths[op.path] = { ...paths[op.path], [op.method]: buildOperation(op) };
  }

  const tags = [...new Set(operations.flatMap((op) => op.tags))].sort().map((name) => ({ name }));

  return {
    openapi: '3.1.0',
    info: { ...OPENAPI_INFO },
    servers: [{ url: '/api/v1' }],
    tags,
    paths,
    components: {
      schemas: {
        ErrorResponse: toSchema(ErrorResponse, 'output'),
        PageMeta: toSchema(PageMeta, 'output'),
      },
    },
  };
}