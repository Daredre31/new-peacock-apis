import type { KeyValueStore } from '../../src/modules/auth/keyValueStore';

/** An in-memory stand-in for Redis, with expiry driven by the test's own clock. */
export function createMemoryStore(now: () => number) {
  const data = new Map<string, { value: string; expiresAt: number }>();
  let down = false;

  const live = (key: string): string | null => {
    const entry = data.get(key);
    if (!entry) return null;
    if (now() >= entry.expiresAt) {
      data.delete(key);
      return null;
    }
    return entry.value;
  };

  const check = (): void => {
    if (down) throw new Error('store is down');
  };

  const store: KeyValueStore = {
    get: async (key) => {
      check();
      return live(key);
    },
    getAndDelete: async (key) => {
      check();
      const value = live(key);
      data.delete(key);
      return value;
    },
    setMany: async (entries) => {
      check();
      for (const { key, value, ttlSeconds } of entries) {
        data.set(key, { value, expiresAt: now() + ttlSeconds * 1000 });
      }
    },
    delete: async (...keys) => {
      check();
      for (const key of keys) data.delete(key);
    },
  };

  return {
    store,
    setDown: (value: boolean) => {
      down = value;
    },
    /** Everything currently stored, as text, so tests can search it for secrets. */
    dump: (): string => JSON.stringify([...data]),
  };
}