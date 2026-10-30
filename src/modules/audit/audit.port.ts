import { logger } from '../../common/utils/logger';

export interface AuditEntry {
  action: string;
  actorId?: string | null;
  entityType?: string;
  entityId?: string;
  ip?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
   before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

export interface AuditPort {
  record(entry: AuditEntry): Promise<void>;
}

export const logAuditPort: AuditPort = {
  record: async (entry) => {
    logger.info({ audit: entry }, 'audit');
  },
};