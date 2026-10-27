import { describe, expect, it } from 'vitest';
import {
  connectRedisClient,
  createRedisClient,
  disconnectRedisClient,
  pingRedisClient,
  redisRetryDelay,
} from '../../src/config/redis';

// Port 1 is closed, so connections are refused straight away.
const UNREACHABLE = 'redis://127.0.0.1:1';

describe('redis retry delay', () => {
  it('backs off and stays capped', () => {
    expect(redisRetryDelay(1)).toBe(200);
    expect(redisRetryDelay(5)).toBe(1000);
    expect(redisRetryDelay(10_000)).toBe(5000);
  });
});

describe('redis client when the server is unreachable', () => {
  it('fails the connect instead of hanging, and stops retrying', async () => {
    const client = createRedisClient(UNREACHABLE, 'test');

    await expect(connectRedisClient(client, 1000)).rejects.toThrow();

    // The first retry delay is 200ms, so 700ms is plenty to catch a client that kept retrying.
    let retries = 0;
    client.on('reconnecting', () => {
      retries += 1;
    });
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(retries).toBe(0);
    expect(client.status).not.toBe('ready');

    client.disconnect();
  });

  it('reports unhealthy instead of throwing', async () => {
    const client = createRedisClient(UNREACHABLE, 'test');
    await connectRedisClient(client, 500).catch(() => undefined);

    const health = await pingRedisClient(client);
    expect(health.ok).toBe(false);

    await disconnectRedisClient(client);
  });
});