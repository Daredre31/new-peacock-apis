import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectMongo, disconnectMongo, pingMongo } from '../../src/config/db';

let replSet: MongoMemoryReplSet;

// The first run downloads a MongoDB binary, so allow plenty of time.
beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
}, 180_000);

afterAll(async () => {
  await disconnectMongo();
  await replSet.stop();
}, 60_000);

describe('mongodb connection', () => {
  it('fails fast when the server is unreachable', async () => {
    await expect(
      connectMongo('mongodb://127.0.0.1:1/peacock_test', { serverSelectionTimeoutMS: 500 }),
    ).rejects.toThrow();

    expect((await pingMongo()).ok).toBe(false);
  });

  it('connects to a replica set and answers pings', async () => {
    await connectMongo(replSet.getUri());

    expect(mongoose.connection.readyState).toBe(1);
    const health = await pingMongo();
    expect(health.ok).toBe(true);
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reports unhealthy after disconnecting', async () => {
    await disconnectMongo();

    expect((await pingMongo()).ok).toBe(false);
  });
});