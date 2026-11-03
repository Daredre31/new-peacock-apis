import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { logger } from '../common/utils/logger';
import { withTimeout } from '../common/utils/withTimeout';

const QUEUE = 'exam-auto-submit';
const ENQUEUE_TIMEOUT_MS = 1_500;

export interface ExamScheduler {
  /** Best effort. A failure is logged and never fails the request, because the sweep catches it later. */
  scheduleAutoSubmit(attemptId: string, endsAt: Date): Promise<void>;
  cancel(attemptId: string): Promise<void>;
}
export interface ExamJobHandlers {
  autoSubmit(attemptId: string): Promise<void>;
  sweep(): Promise<void>;
}

export function createExamJobs(connection: Redis | null) {
  const options = connection ? ({ connection: connection as unknown as ConnectionOptions }) : null;
  const queue = options ? new Queue(QUEUE, options) : null;
  queue?.on('error', (err) => logger.error({ err }, 'exam queue error'));

  let handlers: ExamJobHandlers | null = null;
  let worker: Worker | null = null;

  const scheduler: ExamScheduler = {
    async scheduleAutoSubmit(attemptId, endsAt) {
      if (!queue) return;
      try {
        await withTimeout(
          queue.add('auto-submit', { attemptId }, {
            jobId: `attempt-${attemptId}`,
            delay: Math.max(0, endsAt.getTime() - Date.now()) + 2_000,
            attempts: 5,
            backoff: { type: 'exponential', delay: 5_000 },
            removeOnComplete: true,
            removeOnFail: 500,
          }),
          ENQUEUE_TIMEOUT_MS,
          'Enqueue exam auto-submit',
        );
      } catch (err) {
        logger.warn({ err, attemptId }, 'could not schedule exam auto-submit; the sweep will cover it');
      }
    },
    async cancel(attemptId) {
      if (!queue) return;
      try {
        await withTimeout(queue.remove(`attempt-${attemptId}`), ENQUEUE_TIMEOUT_MS, 'Cancel exam auto-submit');
      } catch {
        // The job just finds nothing to do when it runs.
      }
    },
  };

  return {
    scheduler,

    /** The CBT module registers what the jobs actually do. */
    register(next: ExamJobHandlers): void {
      handlers = next;
    },

    async startWorker(): Promise<void> {
      if (!options || !queue || worker) return;
      worker = new Worker(
        QUEUE,
        async (job) => {
          if (!handlers) throw new Error('Exam job handlers are not registered');
          if (job.name === 'sweep') await handlers.sweep();
          else await handlers.autoSubmit(String((job.data as { attemptId?: unknown }).attemptId));
        },
        { ...options, concurrency: 5 },
      );
      worker.on('error', (err) => logger.error({ err }, 'exam worker error'));
      worker.on('failed', (job, err) => logger.error({ err, jobName: job?.name }, 'exam job failed'));

      await queue.upsertJobScheduler('exam-sweep', { every: 60_000 }, {
        name: 'sweep',
        opts: { removeOnComplete: true, removeOnFail: 100 },
      });
      logger.info('exam workers started');
    },

    async close(): Promise<void> {
      await worker?.close();
      await queue?.close();
    },
  };
}

export type ExamJobs = ReturnType<typeof createExamJobs>;