import mongoose from 'mongoose';
import { afterAll, describe, expect, it } from 'vitest';
import { connectMongo, disconnectMongo, pingMongo } from '../../src/config/db';
import { mongoUriFor } from '../helpers/mongo';

afterAll(async () => {
  await disconnectMongo();
});

describe('mongodb connection', () => {
  it('fails fast when the server is unreachable', async () => {
    await expect(
      connectMongo('mongodb://127.0.0.1:1/peacock_test', { serverSelectionTimeoutMS: 500 }),
    ).rejects.toThrow();

    expect((await pingMongo()).ok).toBe(false);
  });

  it('connects to a replica set and answers pings', async () => {
    await connectMongo(mongoUriFor('peacock_db_test'));

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