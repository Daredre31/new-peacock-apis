import type { Types } from 'mongoose';
import { skipOf } from '../../common/utils/pagination';
import { AuditLogModel, type AuditLogDocument } from './audit.model';

export type AuditRow = AuditLogDocument & { _id: Types.ObjectId };

export interface AuditFilter {
  actorId?: string;
  action?: string;
  entityType?: string;
  entityId?: string;
  from?: Date;
  to?: Date;
  actions?: readonly string[];
}

async function append(entry: Omit<AuditLogDocument, 'createdAt'>): Promise<void> {
  await AuditLogModel.create(entry);
}

async function list(
  filter: AuditFilter,
  options: { page: number; limit: number; sort: 'asc' | 'desc' },
): Promise<{ items: AuditRow[]; total: number }> {
  // Built from validated plain strings only, never from raw request objects.
  const query: Record<string, unknown> = {};
  for (const key of ['actorId', 'action', 'entityType', 'entityId'] as const) {
    const value = filter[key];
    if (value !== undefined) query[key] = value;
  }
    if (filter.actions && filter.actions.length > 0 && filter.action === undefined) {
    query.action = { $in: [...filter.actions] };
  }
  if (filter.from || filter.to) {
    query.createdAt = {
      ...(filter.from && { $gte: filter.from }),
      ...(filter.to && { $lte: filter.to }),
    };
  }

  const direction = options.sort === 'asc' ? 1 : -1;
  const [items, total] = await Promise.all([
    AuditLogModel.find(query)
      .sort({ createdAt: direction, _id: direction })
      .skip(skipOf(options.page, options.limit))
      .limit(options.limit)
      .lean<AuditRow[]>(),
    AuditLogModel.countDocuments(query),
  ]);
  return { items, total };
}

export const auditRepository = { append, list };