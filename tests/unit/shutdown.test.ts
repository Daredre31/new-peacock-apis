import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { logger } from '../../src/common/utils/logger';
import { closeHttpServer, createShutdown } from '../../src/common/utils/shutdown';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('createShutdown', () => {
  it('runs the steps in order and exits 0', async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const shutdown = createShutdown({
      timeoutMs: 1000,
      exit,
      log: logger,
      steps: [
        {
          name: 'a',
          run: async () => {
            await sleep(10);
            order.push('a');
          },
        },
        {
          name: 'b',
          run: async () => {
            order.push('b');
          },
        },
      ],
    });

    await shutdown('test');

    expect(order).toEqual(['a', 'b']);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('uses the exit code it is given', async () => {
    const exit = vi.fn();
    const shutdown = createShutdown({ timeoutMs: 1000, exit, log: logger, steps: [] });

    await shutdown('crash', 1);

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('keeps going when a step fails, then exits 1', async () => {
    const ran: string[] = [];
    const exit = vi.fn();
    const shutdown = createShutdown({
      timeoutMs: 1000,
      exit,
      log: logger,
      steps: [
        {
          name: 'broken',
          run: () => Promise.reject(new Error('boom')),
        },
        {
          name: 'after',
          run: async () => {
            ran.push('after');
          },
        },
      ],
    });

    await shutdown('test');

    expect(ran).toEqual(['after']);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('forces exit when a step hangs', async () => {
    const exit = vi.fn();
    const shutdown = createShutdown({
      timeoutMs: 50,
      exit,
      log: logger,
      steps: [{ name: 'hang', run: () => new Promise<void>(() => {}) }],
    });

    void shutdown('test');
    await sleep(200);

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('forces exit if asked to shut down twice', async () => {
    const exit = vi.fn();
    const shutdown = createShutdown({
      timeoutMs: 1000,
      exit,
      log: logger,
      steps: [{ name: 'slow', run: () => sleep(100) }],
    });

    const first = shutdown('SIGINT');
    await shutdown('SIGINT');

    expect(exit).toHaveBeenNthCalledWith(1, 1);
    await first;
  });
});

describe('closeHttpServer', () => {
  async function listen(handler: Parameters<typeof createServer>[1]) {
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { server, url: `http://127.0.0.1:${port}` };
  }

  it('lets an in-flight request finish before closing', async () => {
    const { server, url } = await listen((_req, res) => {
      setTimeout(() => res.end('done'), 100);
    });

    const inFlight = fetch(url).then((r) => r.text());
    await sleep(30);
    await closeHttpServer(server, 2000);

    expect(await inFlight).toBe('done');
  });

  it('cuts off requests that outlive the grace period', async () => {
    const { server, url } = await listen((_req, res) => {
      setTimeout(() => res.end('late'), 1500);
    });

    const inFlight = fetch(url)
      .then((r) => r.text())
      .catch(() => 'cut');
    await sleep(30);
    await closeHttpServer(server, 100);

    expect(await inFlight).toBe('cut');
  });
});