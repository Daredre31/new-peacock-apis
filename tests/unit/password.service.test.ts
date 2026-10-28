import { describe, expect, it } from 'vitest';
import { createPasswordService } from '../../src/modules/auth/password.service';

// Cheap settings so tests stay fast. Production settings are in PRODUCTION_PASSWORD_OPTIONS.
const cheap = { memoryCost: 1024, timeCost: 1, parallelism: 1, maxConcurrent: 4, maxQueued: 50 };
const service = createPasswordService(cheap);

describe('hashing and verifying', () => {
  it('produces an argon2id hash that verifies', async () => {
    const stored = await service.hashPassword('correct horse 7 battery');

    expect(stored.startsWith('$argon2id$')).toBe(true);
    expect(await service.verifyPassword(stored, 'correct horse 7 battery')).toEqual({
      valid: true,
      needsRehash: false,
    });
  });

  it('rejects the wrong password', async () => {
    const stored = await service.hashPassword('correct horse 7 battery');

    expect((await service.verifyPassword(stored, 'correct horse 8 battery')).valid).toBe(false);
  });

  it('salts every hash differently', async () => {
    const a = await service.hashPassword('same password here');
    const b = await service.hashPassword('same password here');

    expect(a).not.toBe(b);
  });

  it('treats differently-typed but equivalent Unicode as the same password', async () => {
    const stored = await service.hashPassword('ｐａｓｓｗｏｒｄ-ｘ-12345');

    expect((await service.verifyPassword(stored, 'password-x-12345')).valid).toBe(true);
  });
});

describe('inputs that must never succeed or crash', () => {
  it('returns invalid for a missing hash, still doing the work', async () => {
    expect(await service.verifyPassword(null, 'anything at all')).toEqual({
      valid: false,
      needsRehash: false,
    });
    expect((await service.verifyPassword(undefined, 'anything at all')).valid).toBe(false);
    expect((await service.verifyPassword('', 'anything at all')).valid).toBe(false);
  });

  it('returns invalid for a damaged stored hash instead of throwing', async () => {
    expect((await service.verifyPassword('not-a-real-hash', 'whatever password')).valid).toBe(false);
    expect((await service.verifyPassword('$argon2id$garbage', 'whatever password')).valid).toBe(false);
  });

  it('returns invalid for empty, non-string and oversized passwords', async () => {
    const stored = await service.hashPassword('correct horse 7 battery');

    for (const input of ['', 123, null, undefined, { a: 1 }, ['x'], 'x'.repeat(2000)]) {
      expect((await service.verifyPassword(stored, input)).valid, String(input)).toBe(false);
    }
  });
});

describe('rehash detection', () => {
  it('flags hashes made with weaker settings', async () => {
    const weak = createPasswordService(cheap);
    const stronger = createPasswordService({ ...cheap, memoryCost: 2048 });
    const stored = await weak.hashPassword('correct horse 7 battery');

    expect(await stronger.verifyPassword(stored, 'correct horse 7 battery')).toEqual({
      valid: true,
      needsRehash: true,
    });
  });

  it('does not flag a wrong password as needing a rehash', async () => {
    const stronger = createPasswordService({ ...cheap, memoryCost: 2048 });
    const stored = await service.hashPassword('correct horse 7 battery');

    expect(await stronger.verifyPassword(stored, 'wrong password here')).toEqual({
      valid: false,
      needsRehash: false,
    });
  });
});

describe('overload protection', () => {
  it('refuses work beyond the queue limit instead of piling up', async () => {
    const small = createPasswordService({ ...cheap, maxConcurrent: 1, maxQueued: 1 });

    // All three are started in the same tick: one runs, one waits, one is refused.
    const results = await Promise.allSettled([
      small.hashPassword('first password here'),
      small.hashPassword('second password here'),
      small.hashPassword('third password here'),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { code: 'SERVICE_UNAVAILABLE' } });
  });

  it('recovers once the queue drains', async () => {
    const small = createPasswordService({ ...cheap, maxConcurrent: 1, maxQueued: 1 });
    await Promise.allSettled([
      small.hashPassword('first password here'),
      small.hashPassword('second password here'),
      small.hashPassword('third password here'),
    ]);

    await expect(small.hashPassword('fourth password here')).resolves.toMatch(/^\$argon2id\$/);
  });
});

describe('generateTemporaryPassword', () => {
  it('makes three groups of four from unambiguous characters', () => {
    for (let i = 0; i < 100; i += 1) {
      expect(service.generateTemporaryPassword()).toMatch(
        /^[A-HJ-NP-Za-km-z2-9]{4}-[A-HJ-NP-Za-km-z2-9]{4}-[A-HJ-NP-Za-km-z2-9]{4}$/,
      );
    }
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 200 }, () => service.generateTemporaryPassword()));

    expect(seen.size).toBe(200);
  });
});