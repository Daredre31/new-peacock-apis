import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { logger } from '../common/utils/logger';
import { withTimeout } from '../common/utils/withTimeout';

const QUEUE = 'report-export';

export interface ReportScheduler {
  /** True if queued. False means the caller should generate the report itself. */
  enqueue(reportId: string): Promise<boolean>;
}
export interface ReportJobHandlers {
  generate(reportId: string): Promise<void>;
  sweep(): Promise<void>;
}

export function createReportJobs(connection: Redis | null) {
  const options = connection ? { connection: connection as unknown as ConnectionOptions } : null;
  const queue = options ? new Queue(QUEUE, options) : null;
  queue?.on('error', (err) => logger.error({ err }, 'report queue error'));

  let handlers: ReportJobHandlers | null = null;
  let worker: Worker | null = null;

  const scheduler: ReportScheduler = {
    async enqueue(reportId) {
      if (!queue) return false;
      try {
        await withTimeout(
          queue.add('generate', { reportId }, {
            jobId: `report-${reportId}`, attempts: 2, backoff: { type: 'exponential', delay: 5_000 },
            removeOnComplete: true, removeOnFail: 200,
          }),
          1_500, 'Enqueue report',
        );
        return true;
      } catch (err) {
        logger.warn({ err, reportId }, 'could not queue the report; it will be generated in-process');
        return false;
      }
    },
  };

  return {
    scheduler,
    register(next: ReportJobHandlers): void { handlers = next; },

    async startWorker(): Promise<void> {
      if (!options || !queue || worker) return;
      worker = new Worker(
        QUEUE,
        async (job) => {
          if (!handlers) throw new Error('Report job handlers are not registered');
          if (job.name === 'sweep') await handlers.sweep();
          else await handlers.generate(String((job.data as { reportId?: unknown }).reportId));
        },
        { ...options, concurrency: 2 },
      );
            let lastErrorLog = 0;
      worker.on('error', (err) => {
        const now = Date.now();
        if (now - lastErrorLog >= 30_000) {
          lastErrorLog = now;
          logger.error({ err }, 'exam worker error');
        }
      });
      worker.on('failed', (job, err) => logger.error({ err, jobName: job?.name }, 'report job failed'));
      await queue.upsertJobScheduler('report-sweep', { every: 5 * 60_000 }, { name: 'sweep', opts: { removeOnComplete: true, removeOnFail: 100 } });
      logger.info('report workers started');
    },

    async close(): Promise<void> {
      await worker?.close();
      await queue?.close();
    },
  };
}

export type ReportJobs = ReturnType<typeof createReportJobs>;