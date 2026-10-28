import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectMongo, disconnectMongo } from '../../src/config/db';
import { ROLES, USER_STATUS } from '../../src/config/constants';
import { UserModel } from '../../src/modules/users/user.model';
import { userRepository as users } from '../../src/modules/users/user.repository';
import { mongoUriFor } from '../helpers/mongo';

beforeAll(async () => {
  await connectMongo(mongoUriFor('peacock_user_repo_test'));
  await UserModel.init(); // build the unique indexes before testing them
}, 60_000);

afterAll(async () => {
  await disconnectMongo();
});
beforeEach(async () => {
  await UserModel.deleteMany({});
});

describe('create', () => {
  it('normalises email, returns a clean record and never exposes the hash', async () => {
    const user = await users.create({
      email: '  Ada@Example.COM ',
      phone: '+2348012345678',
      passwordHash: 'hash-1',
      role: ROLES.PARENT,
    });

    expect(user.email).toBe('ada@example.com');
    expect(user.phone).toBe('+2348012345678');
    expect(user.status).toBe(USER_STATUS.ACTIVE);
    expect(user.failedLoginCount).toBe(0);
    expect(user.id).toMatch(/^[a-f0-9]{24}$/);
    expect(user).not.toHaveProperty('passwordHash');
    expect(user.emailVerified).toBe(false);
  });

  it('rejects a duplicate email, even in a different case, naming the field', async () => {
    await users.create({ email: 'a@x.co', role: ROLES.PARENT });

    await expect(users.create({ email: 'A@X.CO', role: ROLES.TEACHER })).rejects.toMatchObject({
      code: 'CONFLICT',
      details: [{ field: 'email', issue: 'Already in use' }],
    });
  });

  it('rejects a duplicate phone', async () => {
    await users.create({ phone: '+2348012345678', role: ROLES.PARENT });

    await expect(
      users.create({ phone: '+2348012345678', role: ROLES.PARENT }),
    ).rejects.toMatchObject({ code: 'CONFLICT', details: [{ field: 'phone', issue: 'Already in use' }] });
  });

  it('allows any number of users with no email and no phone', async () => {
    await users.create({ role: ROLES.STUDENT });
    await users.create({ role: ROLES.STUDENT });
    await users.create({ role: ROLES.STUDENT });

    expect(await users.countByRole(ROLES.STUDENT)).toBe(3);
  });

  it('refuses a malformed phone and an unknown role', async () => {
    await expect(users.create({ phone: '0801', role: ROLES.PARENT })).rejects.toThrow();
    await expect(users.create({ role: 'ROOT' as never })).rejects.toThrow();
  });
});

describe('lookups', () => {
  it('findById returns null for bad or missing ids', async () => {
    expect(await users.findById('not-an-id')).toBeNull();
    expect(await users.findById('a'.repeat(24))).toBeNull();
  });

  it('findAuth returns the hash, found by email, phone or id', async () => {
    const created = await users.create({
      email: 'a@x.co',
      phone: '+2348012345678',
      passwordHash: 'hash-1',
      role: ROLES.TEACHER,
    });

    for (const lookup of [{ email: 'a@x.co' }, { phone: '+2348012345678' }, { id: created.id }]) {
      const found = await users.findAuth(lookup);
      expect(found?.id).toBe(created.id);
      expect(found?.passwordHash).toBe('hash-1');
    }
  });

  it('findAuth refuses query operators smuggled in as values', async () => {
    await users.create({ email: 'a@x.co', passwordHash: 'h', role: ROLES.PARENT });

    expect(await users.findAuth({ email: { $ne: null } as unknown as string })).toBeNull();
    expect(await users.findAuth({ id: { $ne: null } as unknown as string })).toBeNull();
    expect(await users.findAuth({ id: 'bad' })).toBeNull();
  });

  it('never finds soft-deleted users', async () => {
    const user = await users.create({ email: 'a@x.co', passwordHash: 'h', role: ROLES.PARENT });
    await UserModel.updateOne({ _id: user.id }, { $set: { deletedAt: new Date() } });

    expect(await users.findById(user.id)).toBeNull();
    expect(await users.findAuth({ email: 'a@x.co' })).toBeNull();
    expect(await users.countByRole(ROLES.PARENT)).toBe(0);
  });
});

describe('lockout', () => {
  const policy = { maxAttempts: 3, lockMs: 60_000 };
  const t0 = new Date('2026-01-01T00:00:00.000Z');
  const at = (ms: number) => new Date(t0.getTime() + ms);

  it('counts failures and locks when the limit is reached', async () => {
    const user = await users.create({ email: 'a@x.co', passwordHash: 'h', role: ROLES.PARENT });

    const first = await users.recordFailedLogin(user.id, policy, t0);
    const second = await users.recordFailedLogin(user.id, policy, t0);
    expect(first?.failedLoginCount).toBe(1);
    expect(second?.lockedUntil).toBeNull();

    const third = await users.recordFailedLogin(user.id, policy, t0);
    expect(third?.failedLoginCount).toBe(3);
    expect(third?.lockedUntil?.toISOString()).toBe(at(60_000).toISOString());
  });

  it('does not extend a lock that is already running', async () => {
    const user = await users.create({ email: 'a@x.co', passwordHash: 'h', role: ROLES.PARENT });
    for (let i = 0; i < 3; i += 1) await users.recordFailedLogin(user.id, policy, t0);

    const during = await users.recordFailedLogin(user.id, policy, at(10_000));

    expect(during?.failedLoginCount).toBe(4);
    expect(during?.lockedUntil?.toISOString()).toBe(at(60_000).toISOString());
  });

  it('starts a fresh count once the lock has run out', async () => {
    const user = await users.create({ email: 'a@x.co', passwordHash: 'h', role: ROLES.PARENT });
    for (let i = 0; i < 3; i += 1) await users.recordFailedLogin(user.id, policy, t0);

    const after = await users.recordFailedLogin(user.id, policy, at(61_000));

    expect(after?.failedLoginCount).toBe(1);
    expect(after?.lockedUntil).toBeNull();
  });

  it('cannot be raced: parallel failures all count and the lock is set once', async () => {
    const user = await users.create({ email: 'a@x.co', passwordHash: 'h', role: ROLES.PARENT });

    await Promise.all(Array.from({ length: 10 }, () => users.recordFailedLogin(user.id, policy, t0)));

    const found = await users.findById(user.id);
    expect(found?.failedLoginCount).toBe(10);
    expect(found?.lockedUntil?.toISOString()).toBe(at(60_000).toISOString());
  });

  it('a successful login clears the count, the lock and records the time', async () => {
    const user = await users.create({ email: 'a@x.co', passwordHash: 'h', role: ROLES.PARENT });
    for (let i = 0; i < 3; i += 1) await users.recordFailedLogin(user.id, policy, t0);

    await users.recordSuccessfulLogin(user.id, at(5_000));

    const found = await users.findById(user.id);
    expect(found?.failedLoginCount).toBe(0);
    expect(found?.lockedUntil).toBeNull();
    expect(found?.lastLoginAt?.toISOString()).toBe(at(5_000).toISOString());
  });

  it('returns null for unknown ids without throwing', async () => {
    expect(await users.recordFailedLogin('a'.repeat(24), policy)).toBeNull();
    expect(await users.recordFailedLogin('bad-id', policy)).toBeNull();
  });
});

describe('setPassword', () => {
  it('activates an invited account and applies the new hash', async () => {
    const user = await users.create({
      email: 'a@x.co',
      role: ROLES.PARENT,
      status: USER_STATUS.INVITED,
    });
    expect((await users.findAuth({ id: user.id }))?.passwordHash).toBeNull();

    expect(await users.setPassword(user.id, 'new-hash', { mustChangePassword: false })).toBe(true);

    const found = await users.findAuth({ id: user.id });
    expect(found?.passwordHash).toBe('new-hash');
    expect(found?.status).toBe(USER_STATUS.ACTIVE);
    expect(found?.passwordChangedAt).not.toBeNull();
  });

  it('clears an automatic lockout but never a manual lock', async () => {
    const user = await users.create({
      email: 'a@x.co',
      passwordHash: 'h',
      role: ROLES.PARENT,
      status: USER_STATUS.LOCKED,
    });
    await users.recordFailedLogin(user.id, { maxAttempts: 1, lockMs: 60_000 });

    await users.setPassword(user.id, 'new-hash', { mustChangePassword: true });

    const found = await users.findById(user.id);
    expect(found?.status).toBe(USER_STATUS.LOCKED);
    expect(found?.failedLoginCount).toBe(0);
    expect(found?.lockedUntil).toBeNull();
    expect(found?.mustChangePassword).toBe(true);
  });

  it('returns false for an unknown user', async () => {
    expect(await users.setPassword('a'.repeat(24), 'h', { mustChangePassword: false })).toBe(false);
  });
});

describe('email verification and counts', () => {
  it('marks an email as verified, only for users who have one', async () => {
    const withEmail = await users.create({ email: 'a@x.co', role: ROLES.SUPER_ADMIN });
    const withoutEmail = await users.create({ role: ROLES.STUDENT });

    expect(await users.markEmailVerified(withEmail.id)).toBe(true);
    expect(await users.markEmailVerified(withoutEmail.id)).toBe(false);
    expect((await users.findById(withEmail.id))?.emailVerified).toBe(true);
  });

  it('counts users by role', async () => {
    await users.create({ email: 'a@x.co', role: ROLES.SUPER_ADMIN });
    await users.create({ role: ROLES.PARENT });

    expect(await users.countByRole(ROLES.SUPER_ADMIN)).toBe(1);
    expect(await users.countByRole(ROLES.ADMIN)).toBe(0);
  });
});