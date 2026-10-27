import { describe, expect, it } from 'vitest';
import { withTimeout } from '../../src/common/utils/withTimeout';

describe('withTimeout', () => {
  it('returns the value when the promise settles in time', async () => {
    await expect(withTimeout(Promise.resolve(42), 100)).resolves.toBe(42);
  });

  it('rejects with the label when the promise is too slow', async () => {
    const never = new Promise<never>(() => {});
    await expect(withTimeout(never, 30, 'Thing')).rejects.toThrow('Thing timed out after 30ms');
  });

  it('passes through the original rejection', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 100)).rejects.toThrow('boom');
  });
});