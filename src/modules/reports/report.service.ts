import { AppError, isAppError } from '../../common/errors/AppError';
import { schoolToday } from '../../common/utils/dates';
import { logger } from '../../common/utils/logger';
import { ROLES, type Role } from '../../config/constants';
import type { ReportScheduler } from '../../jobs/report.jobs';
import { recordSafely, type AuditPort } from '../audit/audit.port';
import type { NotificationService } from '../notifications/notification.service';
import { renderTablePdf, toCsv } from './report.formats';
import type { ReportGenerators, ReportInput } from './report.generators';
import { REPORT_STATUS, type ReportFormat, type ReportRecord, type ReportType, type reportRepository } from './report.repository';

interface Actor { id: string; role: Role }
interface Context { ip: string; requestId: string }

const MAX_IN_FLIGHT = 3;
const MAX_BYTES = 8 * 1024 * 1024; // the file is kept in the database, so it must stay well under MongoDB's 16 MB limit
const STALE_MS = 15 * 60_000;

const view = (r: ReportRecord) => ({
  id: r.id, type: r.type, format: r.format, status: r.status, error: r.error, fileName: r.fileName, size: r.size, rowCount: r.rowCount,
  createdAt: r.createdAt.toISOString(), completedAt: r.completedAt ? r.completedAt.toISOString() : null, expiresAt: r.expiresAt.toISOString(),
  downloadable: r.status === REPORT_STATUS.READY,
});

export function createReportService(deps: {
  repo: typeof reportRepository;
  generators: ReportGenerators;
  scheduler: ReportScheduler;
  notifier: Pick<NotificationService, 'notify'>;
  audit: AuditPort;
}) {
  const { repo, generators, scheduler, notifier, audit } = deps;

  async function generate(id: string): Promise<void> {
    const claimed = await repo.claim(id);
    if (!claimed) return; // someone else has it, or it is already done

    try {
      const table = await generators.run(claimed.type, claimed.params);
      const isCsv = claimed.format === 'CSV';
      const content = isCsv ? Buffer.from(toCsv(table), 'utf8') : await renderTablePdf(table);
      if (content.length > MAX_BYTES) throw new AppError('VALIDATION_ERROR', { message: 'The report is too large. Narrow it down and try again' });

      await repo.complete(id, {
        fileName: `${claimed.type.toLowerCase().replace(/_/g, '-')}-${schoolToday()}.${isCsv ? 'csv' : 'pdf'}`,
        contentType: isCsv ? 'text/csv; charset=utf-8' : 'application/pdf', content, rowCount: table.rows.length,
      });
      await notifier.notify({ userIds: [claimed.requestedBy], type: 'REPORT_READY', title: 'Your report is ready', body: `${table.title} (${claimed.format}) can be downloaded for 7 days.`, data: { reportId: id }, email: false });
    } catch (err) {
      logger.error({ err, reportId: id }, 'report generation failed');
      await repo.fail(id, isAppError(err) ? err.message : 'The report could not be generated');
    }
  }

  async function mustOwn(actor: Actor, id: string): Promise<ReportRecord> {
    const record = await repo.findById(id);
    if (!record || (record.requestedBy !== actor.id && actor.role !== ROLES.SUPER_ADMIN)) throw new AppError('NOT_FOUND');
    return record;
  }

  return {
    generate,

    async sweep(): Promise<void> {
      const expired = await repo.expireStale(new Date(Date.now() - STALE_MS));
      if (expired > 0) logger.warn({ expired }, 'marked stuck reports as failed');
    },

    /** Checks the request, queues the job and returns at once. The client polls GET /reports/{id}. */
    async create(actor: Actor, type: ReportType, input: ReportInput & { format: ReportFormat }, ctx: Context) {
      if ((await repo.countInFlight(actor.id)) >= MAX_IN_FLIGHT) {
        throw new AppError('CONFLICT', { message: 'You already have reports being prepared. Wait for them to finish.' });
      }
      const params = await generators.prepare(type, input);
      const record = await repo.create({ type, format: input.format, params, requestedBy: actor.id });

      await recordSafely(audit, {
        action: 'REPORT_REQUESTED', actorId: actor.id, entityType: 'report', entityId: record.id, ip: ctx.ip, requestId: ctx.requestId,
        metadata: { type, format: input.format, params },
      });

      if (!(await scheduler.enqueue(record.id))) {
        void generate(record.id).catch((err: unknown) => logger.error({ err, reportId: record.id }, 'in-process report generation crashed'));
      }
      return view(record);
    },

    async get(actor: Actor, id: string) {
      return view(await mustOwn(actor, id));
    },

    async download(actor: Actor, id: string, ctx: Context) {
      const record = await mustOwn(actor, id);
      if (record.status !== REPORT_STATUS.READY) throw new AppError('CONFLICT', { message: record.status === REPORT_STATUS.FAILED ? (record.error ?? 'The report failed') : 'The report is not ready yet' });

      const file = await repo.content(id);
      if (!file) throw new AppError('NOT_FOUND');
      await recordSafely(audit, { action: 'REPORT_DOWNLOADED', actorId: actor.id, entityType: 'report', entityId: id, ip: ctx.ip, requestId: ctx.requestId, metadata: { type: record.type } });
      return file;
    },
  };
}

export type ReportService = ReturnType<typeof createReportService>;