import type { RequestHandler } from 'express';
import { z, type ZodError } from 'zod';
import { AppError, type ErrorDetail } from '../errors/AppError';

type Source = 'body' | 'query' | 'params';
const SOURCES: readonly Source[] = ['body', 'query', 'params'];

export interface ValidationSchemas {
  body?: z.ZodObject;
  query?: z.ZodObject;
  params?: z.ZodObject;
}

/** Type of req.validated for a given set of schemas. */
export type Validated<S extends ValidationSchemas> = {
  [K in keyof S]: S[K] extends z.ZodType ? z.output<S[K]> : never;
};

const MAX_DEPTH = 10;
const MAX_DETAILS = 50;
const MAX_FIELD_LENGTH = 100;

// A source with no schema must be empty. This is how "unknown fields are
// rejected" and "every route validates body, query and params" are enforced.
const EMPTY = z.object({});

const clip = (value: string): string => value.slice(0, MAX_FIELD_LENGTH);

/**
 * Finds keys that must never reach a database query: operators ($ne, $gt),
 * dotted paths, and __proto__. Also rejects absurdly deep nesting.
 */
function findUnsafeKey(value: unknown, path = '', depth = 0): ErrorDetail | null {
  if (value === null || typeof value !== 'object') return null;
  if (depth > MAX_DEPTH) return { field: clip(path), issue: 'Too deeply nested' };

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findUnsafeKey(item, `${path}[${index}]`, depth + 1);
      if (found) return found;
    }
    return null;
  }

  for (const [key, child] of Object.entries(value)) {
    const keyPath = path ? `${path}.${key}` : key;
    if (key.startsWith('$') || key.includes('.') || key === '__proto__') {
      return { field: clip(keyPath), issue: 'Invalid key' };
    }
    const found = findUnsafeKey(child, keyPath, depth + 1);
    if (found) return found;
  }
  return null;
}

function toDetails(issues: ZodError['issues'], source: Source): ErrorDetail[] {
  const details: ErrorDetail[] = [];
  for (const issue of issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        const field = [...issue.path, key].map(String).join('.');
        details.push({ field: clip(field), issue: 'Unknown field' });
      }
      continue;
    }
    details.push({
      field: clip(issue.path.map(String).join('.') || source),
      issue: issue.message,
    });
  }
  return details;
}

export function validate<S extends ValidationSchemas>(schemas: S): RequestHandler {
  return (req, _res, next) => {
    const details: ErrorDetail[] = [];
    const validated: Record<string, unknown> = {};

    for (const source of SOURCES) {
      const input: unknown = req[source];

      const unsafe = findUnsafeKey(input);
      if (unsafe) {
        details.push(unsafe);
        continue;
      }

      const schema = schemas[source] ?? EMPTY;
      const result = schema.strict().safeParse(input ?? {});

      if (result.success) {
        validated[source] = result.data;
      } else {
        details.push(...toDetails(result.error.issues, source));
      }
    }

    if (details.length > 0) {
      next(new AppError('VALIDATION_ERROR', { details: details.slice(0, MAX_DETAILS) }));
      return;
    }

    req.validated = validated;
    next();
  };
}