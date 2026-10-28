import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { connectMongo, disconnectMongo } from '../../src/config/db';
import { ROLES } from '../../src/config/constants';
import { passwordService } from '../../src/modules/auth/password.service';
import { UserModel } from '../../src/modules/users/user.model';
import { userRepository } from '../../src/modules/users/user.repository';
import { createMemoryStore } from '../helpers/memoryStore';
import { mongoUriFor } from '../helpers/mongo';

const PASSWORD = 'correct horse 7 battery';
const healthy = () => Promise.resolve({ ok: true, latencyMs: 1 });

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await connectMongo(mongoUriFor('peacock_auth_test'));
  await UserModel.init();
}, 60_000);

afterAll(async () => {
  await disconnectMongo();
});

beforeEach(async () => {
  await UserModel.deleteMany({});
  await userRepository.create({
    email: 'parent@example.com',
    phone: '+2348012345678',
    passwordHash: await passwordService.hashPassword(PASSWORD),
    role: ROLES.PARENT,
  });
  // A fresh app per test, so rate limiters and sessions never leak between tests.
  app = createApp({
    rateLimitRedis: null,
    sessionStore: createMemoryStore(Date.now).store,
    checkMongo: healthy,
    checkRedis: healthy,
    docsEnabled: false,
  });
});

const login = (identifier = 'parent@example.com', password = PASSWORD) =>
  request(app).post('/api/v1/auth/login').send({ identifier, password });

type Res = Awaited<ReturnType<typeof login>>;

const setCookies = (res: Res): string[] => {
  const raw: unknown = res.headers['set-cookie'];
  if (Array.isArray(raw)) return raw.map(String);
  return typeof raw === 'string' ? [raw] : [];
};
const pairs = (res: Res): string[] => setCookies(res).map((c) => c.split(';')[0] ?? '');
const jar = (res: Res): string => pairs(res).join('; ');
const cookieLine = (res: Res, name: string): string =>
  setCookies(res).find((c) => c.startsWith(`${name}=`)) ?? '';
const csrfOf = (res: Res): string => (pairs(res).find((c) => c.startsWith('pa_csrf=')) ?? '').slice(8);

describe('login', () => {
  it('works with email or phone and sets httpOnly cookies with the right scope', async () => {
    for (const identifier of ['parent@example.com', '0801 234 5678']) {
      const res = await login(identifier);
      expect(res.status, identifier).toBe(200);
      expect(res.body.data.user).toMatchObject({ role: ROLES.PARENT, email: 'parent@example.com' });

      expect(cookieLine(res, 'pa_access')).toContain('HttpOnly');
      const refresh = cookieLine(res, 'pa_refresh');
      expect(refresh).toContain('HttpOnly');
      expect(refresh).toContain('Path=/api/v1/auth/refresh');
      expect(refresh).toContain('SameSite=Strict');
      expect(cookieLine(res, 'pa_csrf')).not.toContain('HttpOnly');
    }
  });

  it('never puts a token in the response body', async () => {
    const res = await login();
    const body = JSON.stringify(res.body);

    for (const pair of pairs(res)) expect(body).not.toContain(pair.split('=')[1] ?? 'x');
    expect(body.toLowerCase()).not.toContain('token');
  });

  it('answers identically for a wrong password, an unknown user and a junk identifier', async () => {
    const results = await Promise.all([
      login('parent@example.com', 'wrong password here'),
      login('nobody@example.com'),
      login('$ne'),
    ]);

    for (const res of results) {
      expect(res.status).toBe(401);
      expect(res.body.error).toEqual(results[0]?.body.error);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    }
  });

  it('refuses a locked account even with the right password', async () => {
    await UserModel.updateOne({ email: 'parent@example.com' }, { $set: { lockedUntil: new Date(Date.now() + 600_000) } });

    const res = await login();
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_LOCKED');
    expect(res.body.error.retryAfter).toBeGreaterThan(0);
  });

  it('rate limits repeated attempts per identifier', async () => {
    for (let i = 0; i < 5; i += 1) {
      expect((await login('parent@example.com', 'wrong password here')).status).toBe(401);
    }

    expect((await login()).status).toBe(429);
  });
});

describe('session', () => {
  it('serves /me only with the cookie, and logout needs the CSRF token', async () => {
    const res = await login();
    const cookie = jar(res);

    expect((await request(app).get('/api/v1/auth/me').set('Cookie', cookie)).status).toBe(200);
    expect((await request(app).get('/api/v1/auth/me')).status).toBe(401);

    const noToken = await request(app).post('/api/v1/auth/logout').set('Cookie', cookie);
    expect(noToken.status).toBe(403);
    expect(noToken.body.error.code).toBe('CSRF_INVALID');
  });

  it('logout ends the login at once, even for a cookie that has not expired', async () => {
    const res = await login();
    const cookie = jar(res);

    const out = await request(app).post('/api/v1/auth/logout').set('Cookie', cookie).set('X-CSRF-Token', csrfOf(res));
    expect(out.status).toBe(200);

    expect((await request(app).get('/api/v1/auth/me').set('Cookie', cookie)).status).toBe(401);
  });

  it('logout-all ends every login the user has', async () => {
    const first = await login();
    const second = await login();

    const out = await request(app)
      .post('/api/v1/auth/logout-all')
      .set('Cookie', jar(first))
      .set('X-CSRF-Token', csrfOf(first));
    expect(out.status).toBe(200);

    expect((await request(app).get('/api/v1/auth/me').set('Cookie', jar(second))).status).toBe(401);
  });

  it('rotates the refresh cookie, and treats an instant replay as a retry, not as theft', async () => {
    const res = await login();
    const cookie = jar(res);
    const csrf = csrfOf(res);

    const refreshed = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie).set('X-CSRF-Token', csrf);
    expect(refreshed.status).toBe(200);
    expect(cookieLine(refreshed, 'pa_refresh')).not.toBe(cookieLine(res, 'pa_refresh'));

    const replay = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie).set('X-CSRF-Token', csrf);
    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe('CONFLICT');

    expect((await request(app).get('/api/v1/auth/me').set('Cookie', jar(refreshed))).status).toBe(200);
  });

  it('refuses to refresh without a valid refresh cookie, and clears the cookies', async () => {
    const res = await request(app).post('/api/v1/auth/refresh').set('Cookie', 'pa_refresh=A');

    expect(res.status).toBe(403); // no CSRF token: the session cookie makes CSRF mandatory
    const login1 = await login();
    const bad = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', `pa_refresh=${'A'.repeat(43)}; pa_csrf=${csrfOf(login1)}`)
      .set('X-CSRF-Token', csrfOf(login1));

    expect(bad.status).toBe(401);
    expect(setCookies(bad).join('\n')).toContain('pa_refresh=;');
  });
});