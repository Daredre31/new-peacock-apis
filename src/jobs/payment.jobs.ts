import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { logger } from '../common/utils/logger';
import { withTimeout } from '../common/utils/withTimeout';

const QUEUE = 'payments';

export interface PaymentScheduler {
  /** False means the caller should run it itself. */
  enqueueReconcile(days: number, triggeredBy: string | null): Promise<boolean>;
}
export interface PaymentJobHandlers {
  sweep(): Promise<void>;
  reconcile(days: number, triggeredBy: string | null, kind: 'SCHEDULED' | 'MANUAL'): Promise<void>;
}

export function createPaymentJobs(connection: Redis | null) {
  const options = connection ? { connection: connection as unknown as ConnectionOptions } : null;
  const queue = options ? new Queue(QUEUE, options) : null;
  queue?.on('error', (err) => logger.error({ err }, 'payments queue error'));

  let handlers: PaymentJobHandlers | null = null;
  let worker: Worker | null = null;

  const scheduler: PaymentScheduler = {
    async enqueueReconcile(days, triggeredBy) {
      if (!queue) return false;
      try {
        await withTimeout(queue.add('reconcile', { days, triggeredBy, kind: 'MANUAL' }, { attempts: 1, removeOnComplete: true, removeOnFail: 100 }), 1_500, 'Enqueue reconcile');
        return true;
      } catch (err) {
        logger.warn({ err }, 'could not queue the reconciliation; it will run in-process');
        return false;
      }
    },
  };

  return {
    scheduler,
    register(next: PaymentJobHandlers): void { handlers = next; },

    async startWorker(): Promise<void> {
      if (!options || !queue || worker) return;
      let lastErrorLog = 0;
      worker = new Worker(
        QUEUE,
        async (job) => {
          if (!handlers) throw new Error('Payment job handlers are not registered');
          if (job.name === 'sweep') { await handlers.sweep(); return; }
          const data = job.data as { days?: unknown; triggeredBy?: unknown; kind?: unknown };
          const days = typeof data.days === 'number' && data.days >= 1 && data.days <= 14 ? data.days : 3;
          await handlers.reconcile(days, typeof data.triggeredBy === 'string' ? data.triggeredBy : null, data.kind === 'MANUAL' ? 'MANUAL' : 'SCHEDULED');
        },
        { ...options, concurrency: 1 },
      );
      worker.on('error', (err) => {
        if (Date.now() - lastErrorLog >= 30_000) { lastErrorLog = Date.now(); logger.error({ err }, 'payments worker error'); }
      });
      worker.on('failed', (job, err) => logger.error({ err, jobName: job?.name }, 'payments job failed'));

      await queue.upsertJobScheduler('payments-sweep', { every: 60_000 }, { name: 'sweep', opts: { removeOnComplete: true, removeOnFail: 100 } });
      await queue.upsertJobScheduler('payments-reconcile', { pattern: '0 2 * * *', tz: 'Africa/Lagos' }, { name: 'reconcile', data: { days: 3, kind: 'SCHEDULED' }, opts: { removeOnComplete: true, removeOnFail: 100 } });
      logger.info('payment workers started');
    },

    async close(): Promise<void> {
      await worker?.close();
      await queue?.close();
    },
  };
}

export type PaymentJobs = ReturnType<typeof createPaymentJobs>;