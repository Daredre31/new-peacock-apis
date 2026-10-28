import type { Redis } from 'ioredis';

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  /** Reads and removes in one atomic step, so two requests can never both receive the same value. */
  getAndDelete(key: string): Promise<string | null>;
  /** Writes several keys together, each with its own lifetime in seconds. */
  setMany(entries: { key: string; value: string; ttlSeconds: number }[]): Promise<void>;
  delete(...keys: string[]): Promise<void>;
}

export function createRedisKeyValueStore(client: Redis): KeyValueStore {
  return {
    get: (key) => client.get(key),

    // GETDEL needs Redis 6.2 or newer, which every current hosted Redis has.
    getAndDelete: (key) => client.getdel(key),

    async setMany(entries) {
      const pipeline = client.multi();
      for (const entry of entries) {
        pipeline.set(entry.key, entry.value, 'EX', Math.max(1, Math.floor(entry.ttlSeconds)));
      }
      const results = await pipeline.exec();
      if (!results || results.some(([err]) => err)) throw new Error('Redis write failed');
    },

    async delete(...keys) {
      if (keys.length > 0) await client.del(...keys);
    },
  };
}