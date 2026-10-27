import type { Server } from 'node:http';
import type { Logger } from 'pino';

export interface ShutdownStep {
  name: string;
  run: () => Promise<void>;
}

export interface ShutdownOptions {
  /** Run in order. A failing step is logged and the rest still run. */
  steps: ShutdownStep[];
  /** Hard limit for the whole shutdown. After it, the process is forced to exit. */
  timeoutMs: number;
  exit: (code: number) => void;
  log: Pick<Logger, 'info' | 'warn' | 'error'>;
}

export function createShutdown(options: ShutdownOptions) {
  const { steps, timeoutMs, exit, log } = options;
  let started = false;

  return async function shutdown(reason: string, exitCode = 0): Promise<void> {
    // A second Ctrl+C (or signal) means "stop waiting".
    if (started) {
      log.warn({ reason }, 'shutdown already in progress, forcing exit');
      exit(1);
      return;
    }
    started = true;
    log.info({ reason }, 'shutting down');

    // Not unref'd on purpose: it must keep the process alive while a step hangs.
    const timer = setTimeout(() => {
      log.error({ timeoutMs }, 'shutdown timed out, forcing exit');
      exit(1);
    }, timeoutMs);

    let failed = false;
    for (const step of steps) {
      try {
        await step.run();
        log.info({ step: step.name }, 'shutdown step done');
      } catch (err) {
        failed = true;
        log.error({ err, step: step.name }, 'shutdown step failed');
      }
    }

    clearTimeout(timer);
    exit(failed ? 1 : exitCode);
  };
}

/**
 * Stops accepting connections, lets in-flight requests finish, and after
 * `graceMs` cuts off whatever is still open so shutdown cannot stall.
 */
export function closeHttpServer(server: Server, graceMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => server.closeAllConnections(), graceMs);

    server.close((err) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    });

    server.closeIdleConnections();
  });
}