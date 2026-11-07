import { createServer, type Server } from 'node:http';
import { createApp } from './app';
import { logger } from './common/utils/logger';
import { closeHttpServer, createShutdown } from './common/utils/shutdown';
import { connectMongo, disconnectMongo, pingMongo ,ensureIndexes } from './config/db';
import { env } from './config/env';
import { connectRedis, disconnectRedis, pingRedis, rateLimitRedis ,redis , createBullMQConnection ,disconnectRedisClient} from './config/redis';
import { createRedisKeyValueStore } from './modules/auth/keyValueStore';
import type Redis from 'ioredis';
import { createExamJobs, type ExamJobs } from './jobs/exam.jobs';
import { createReportJobs, type ReportJobs } from './jobs/report.jobs';
import { createPaymentJobs, type PaymentJobs } from './jobs/payment.jobs';

const SHUTDOWN_TIMEOUT_MS = 15_000;
const HTTP_DRAIN_MS = 10_000;

let server: Server | undefined;
let shuttingDown = false;
let jobs: ExamJobs | undefined;
let bullmq: Redis | undefined;
let reportJobs: ReportJobs | undefined;
let paymentJobs: PaymentJobs | undefined;
// Order matters: stop taking requests first, then close what they were using.
// Later phases add the BullMQ workers here, between http and redis.
const shutdown = createShutdown({
  timeoutMs: SHUTDOWN_TIMEOUT_MS,
  exit: (code) => process.exit(code),
  log: logger,
  steps: [
    {
      name: 'http',
      run: async () => {
        if (server?.listening) await closeHttpServer(server, HTTP_DRAIN_MS);
      },
    },
    { name: 'redis', run: disconnectRedis },
    { name: 'mongodb', run: disconnectMongo },
   { name: 'jobs', run: async () => { await jobs?.close(); await reportJobs?.close(); await paymentJobs?.close(); } },
    { name: 'bullmq-redis', run: async () => { if (bullmq) await disconnectRedisClient(bullmq); } },
  ],
});

function stop(reason: string, exitCode = 0): Promise<void> {
  shuttingDown = true;
  return shutdown(reason, exitCode);
}

const unavailable = () => Promise.resolve({ ok: false, latencyMs: 0 });

async function main(): Promise<void> {
  // Both dependencies must be up before we accept traffic. The rate limiter is
  // created inside createApp, so it only ever sees a connected Redis.
  await connectMongo();
  await ensureIndexes();
  await connectRedis();
    bullmq = createBullMQConnection();
  jobs = createExamJobs(bullmq);
  
  reportJobs = createReportJobs(bullmq);
  paymentJobs = createPaymentJobs(bullmq);

  const app = createApp({
    sessionStore: createRedisKeyValueStore(redis),
    rateLimitRedis,
    examJobs: jobs,
    // Once shutdown starts, /ready answers 503 so the load balancer stops sending traffic.
    checkMongo: () => (shuttingDown ? unavailable() : pingMongo()),
    checkRedis: () => (shuttingDown ? unavailable() : pingRedis()),
    reportJobs,
    paymentJobs,
  });

  const httpServer = createServer(app);
  // Behind a proxy or load balancer, keep-alive must outlast theirs (commonly 60s).
  httpServer.keepAliveTimeout = 65_000;
  httpServer.headersTimeout = 66_000;
  httpServer.requestTimeout = 120_000;
  server = httpServer;

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject); // for example EADDRINUSE
    httpServer.listen(env.PORT, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  httpServer.on('error', (err) => logger.error({ err }, 'http server error'));
      if (env.WORKERS_ENABLED) {
    await jobs.startWorker();
    await reportJobs.startWorker();
    await paymentJobs.startWorker();
  }
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'server listening');
}

process.on('SIGINT', () => void stop('SIGINT'));
process.on('SIGTERM', () => void stop('SIGTERM'));

// After either of these the process state cannot be trusted, so we
// shut down and exit non-zero, and let the process manager restart us.
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled promise rejection');
  void stop('unhandledRejection', 1);
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception');
  void stop('uncaughtException', 1);
});

main().catch((err: unknown) => {
  logger.fatal({ err }, 'failed to start');
  void stop('boot failure', 1);
});