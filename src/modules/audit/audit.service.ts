import type { AuditEntry, AuditPort } from './audit.port';
import { auditRepository, type AuditFilter } from './audit.repository';

const SENSITIVE_KEY = /password|passwd|token|secret|authorization|cookie|hash|otp|api_?key/i;
const MAX_DEPTH = 6;
const MAX_ITEMS = 50;
const MAX_STRING = 500;
const MAX_BYTES = 16_000;

/** Secrets never reach the audit log, even if a caller passes them by mistake. */
function sanitize(value: unknown, depth = 0): unknown {
  if (value instanceof Date) return value;
  if (value === null || typeof value !== 'object') {
    return typeof value === 'string' && value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((item) => sanitize(item, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    // Keys with $ or . are not allowed inside stored documents.
    const safeKey = key.replace(/[.$]/g, '_');
    out[safeKey] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitize(child, depth + 1);
  }
  return out;
}

function clean(value?: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!value) return null;
  const result = sanitize(value) as Record<string, unknown>;
  return JSON.stringify(result).length > MAX_BYTES ? { truncated: true } : result;
}

export interface ListAuditInput extends AuditFilter {
  page: number;
  limit: number;
  sort: 'createdAt' | '-createdAt';
}

export function createAuditService() {
  return {
    async record(entry: AuditEntry): Promise<void> {
      await auditRepository.append({
        action: entry.action,
        actorId: entry.actorId ?? null,
        entityType: entry.entityType,
        entityId: entry.entityId,
        ip: entry.ip,
        requestId: entry.requestId,
        before: clean(entry.before),
        after: clean(entry.after),
        metadata: clean(entry.metadata),
      });
    },

    async list(input: ListAuditInput) {
      const { page, limit, sort, ...filter } = input;
      const { items, total } = await auditRepository.list(filter, {
        page,
        limit,
        sort: sort === 'createdAt' ? 'asc' : 'desc',
      });

      return {
        total,
        items: items.map((row) => ({
          id: String(row._id),
          action: row.action,
          actorId: row.actorId ?? null,
          entityType: row.entityType ?? null,
          entityId: row.entityId ?? null,
          ip: row.ip ?? null,
          requestId: row.requestId ?? null,
          before: row.before ?? null,
          after: row.after ?? null,
          metadata: row.metadata ?? null,
          createdAt: row.createdAt.toISOString(),
        })),
      };
    },
  } satisfies AuditPort & { list: unknown };
}

export type AuditService = ReturnType<typeof createAuditService>;