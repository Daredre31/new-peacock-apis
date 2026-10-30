import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectMongo, disconnectMongo } from '../../src/config/db';
import { ROLES } from '../../src/config/constants';
import type { Mailer } from '../../src/integrations/mailer';
import { createCredentialsService } from '../../src/modules/auth/credentials.service';
import { createPasswordService } from '../../src/modules/auth/password.service';
import { createTokenService } from '../../src/modules/auth/token.service';
import { UserModel } from '../../src/modules/users/user.model';
import { userRepository } from '../../src/modules/users/user.repository';
import { createMemoryStore } from '../helpers/memoryStore';
import { mongoUriFor } from '../helpers/mongo';

const passwords = createPasswordService({ memoryCost: 1024, timeCost: 1, parallelism: 1, maxConcurrent: 4, maxQueued: 50 });
const OLD = 'correct horse 7 battery';
const NEW = 'purple tractor 42 lantern';
const ctx = { ip: '1.1.1.1', requestId: 'req-12345678' };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let mails: { to: string; text: string }[];
let service: ReturnType<typeof createCredentialsService>;
let tokens: ReturnType<typeof createTokenService>;
let userId: string;

beforeAll(async () => {
  await connectMongo(mongoUriFor('peacock_credentials_test'));
  await UserModel.init();
}, 60_000);

afterAll(async () => {
  await disconnectMongo();
});

beforeEach(async () => {
  await UserModel.deleteMany({});
  userId = (
    await userRepository.create({
      email: 'ada@example.com',
      passwordHash: await passwords.hashPassword(OLD),
      role: ROLES.PARENT,
    })
  ).id;

  const memory = createMemoryStore(Date.now);
  tokens = createTokenService({
    store: memory.store,
    accessSecret: 'access-secret-for-tests-0123456789-abcdef',
    refreshSecret: 'refresh-secret-for-tests-0123456789-abcde',
  });
  mails = [];
  const mailer: Mailer = { send: async (mail) => void mails.push(mail) };
  service = createCredentialsService({
    users: userRepository,
    passwords,
    tokens,
    audit: { record: async () => undefined },
    mailer,
    store: memory.store,
    secret: 'reset-secret-for-tests-0123456789-abcdefg',
    frontendOrigin: 'http://localhost:5173',
  });
});

const tokenFromMail = (): string => /#token=([A-Za-z0-9_-]{43})/.exec(mails.at(-1)?.text ?? '')?.[1] ?? '';
const startLogin = () => tokens.issueSession({ userId, role: ROLES.PARENT, mustChangePassword: false });

describe('password reset', () => {
  it('works once, ends every login, and the link cannot be reused', async () => {
    const session = await startLogin();
    await wait(5);
    await service.requestPasswordReset({ identifier: 'Ada@Example.com', ...ctx });
    const token = tokenFromMail();
    expect(token).toHaveLength(43);

    await service.resetPassword({ token, newPassword: NEW, ...ctx });

    const stored = await userRepository.findAuth({ id: userId });
    expect((await passwords.verifyPassword(stored?.passwordHash, NEW)).valid).toBe(true);
    expect(await tokens.isSessionActive({ userId, sessionId: session.sessionId })).toBe(false);
    await expect(service.resetPassword({ token, newPassword: NEW, ...ctx })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: [{ field: 'token' }],
    });
  });

  it('reveals nothing for unknown accounts and sends no mail for accounts without an email', async () => {
    await userRepository.create({ phone: '+2348012345678', passwordHash: await passwords.hashPassword(OLD), role: ROLES.PARENT });

    await service.requestPasswordReset({ identifier: 'nobody@example.com', ...ctx });
    await service.requestPasswordReset({ identifier: '08012345678', ...ctx });
    await service.requestPasswordReset({ identifier: 'STF-0007', ...ctx });
    await service.requestPasswordReset({ identifier: '$ne', ...ctx });

    expect(mails).toHaveLength(0);
  });

  it('a newer link kills the older one', async () => {
    await service.requestPasswordReset({ identifier: 'ada@example.com', ...ctx });
    const first = tokenFromMail();
    await service.requestPasswordReset({ identifier: 'ada@example.com', ...ctx });

    await expect(service.resetPassword({ token: first, newPassword: NEW, ...ctx })).rejects.toThrow();
    await expect(service.resetPassword({ token: tokenFromMail(), newPassword: NEW, ...ctx })).resolves.toBeUndefined();
  });

  it('a weak password is refused without using up the link', async () => {
    await service.requestPasswordReset({ identifier: 'ada@example.com', ...ctx });
    const token = tokenFromMail();

    await expect(service.resetPassword({ token, newPassword: 'short', ...ctx })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(service.resetPassword({ token, newPassword: NEW, ...ctx })).resolves.toBeUndefined();
  });

  it('a password change after the link was issued kills the link', async () => {
    await service.requestPasswordReset({ identifier: 'ada@example.com', ...ctx });
    const token = tokenFromMail();
    await wait(5);
    await userRepository.setPassword(userId, await passwords.hashPassword('another long phrase 99'), { mustChangePassword: false });

    await expect(service.resetPassword({ token, newPassword: NEW, ...ctx })).rejects.toThrow();
  });

  it('rejects malformed and guessed tokens', async () => {
    for (const token of ['', 'abc', 'A'.repeat(43), '../../x']) {
      await expect(service.resetPassword({ token, newPassword: NEW, ...ctx })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
  });
});

describe('change password', () => {
  it('ends other logins, keeps the caller logged in with a new session, and sets the new password', async () => {
    const other = await startLogin();
    await wait(5);

    const { session } = await service.changePassword({ userId, currentPassword: OLD, newPassword: NEW, ...ctx });

    expect(await tokens.isSessionActive({ userId, sessionId: other.sessionId })).toBe(false);
    expect(await tokens.isSessionActive({ userId, sessionId: session.sessionId })).toBe(true);
    const stored = await userRepository.findAuth({ id: userId });
    expect((await passwords.verifyPassword(stored?.passwordHash, NEW)).valid).toBe(true);
  });

  it('a wrong current password is refused and counts toward the lockout', async () => {
    await expect(
      service.changePassword({ userId, currentPassword: 'wrong password here', newPassword: NEW, ...ctx }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', details: [{ field: 'currentPassword' }] });

    expect((await userRepository.findById(userId))?.failedLoginCount).toBe(1);
  });

  it('refuses the same password and weak passwords', async () => {
    await expect(service.changePassword({ userId, currentPassword: OLD, newPassword: OLD, ...ctx })).rejects.toThrow();
    await expect(service.changePassword({ userId, currentPassword: OLD, newPassword: 'short', ...ctx })).rejects.toThrow();
  });
});