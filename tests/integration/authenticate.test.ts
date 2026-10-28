import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAuthMiddleware, type AuthUserRecord } from '../../src/common/middleware/authenticate';
import { authorize } from '../../src/common/middleware/authorize';
import { errorHandler } from '../../src/common/middleware/errorHandler';
import { requestId } from '../../src/common/middleware/requestId';
import { ROLES, USER_STATUS } from '../../src/config/constants';
import { createTokenService } from '../../src/modules/auth/token.service';
import { createMemoryStore } from '../helpers/memoryStore';

const USER_ID = 'a'.repeat(24);
const MINUTE = 60_000;

let clock: number;
let memory: ReturnType<typeof createMemoryStore>;
let tokens: ReturnType<typeof createTokenService>;
let dbUser: AuthUserRecord | null;
let dbDown: boolean;

beforeEach(() => {
  clock = Date.parse('2026-01-01T00:00:00.000Z');
  memory = createMemoryStore(() => clock);
  tokens = createTokenService({
    store: memory.store,
    accessSecret: 'access-secret-for-tests-0123456789-abcdef',
    refreshSecret: 'refresh-secret-for-tests-0123456789-abcde',
    now: () => clock,
  });
  dbUser = { id: USER_ID, role: ROLES.PARENT, status: USER_STATUS.ACTIVE, mustChangePassword: false };
  dbDown = false;
});

function makeApp() {
  const { authenticate, authenticateAllowingPasswordChange } = createAuthMiddleware({
    tokens,
    findUser: async () => {
      if (dbDown) throw new Error('db down');
      return dbUser;
    },
    userRateLimiter: (_req, _res, next) => {
      next();
    },
  });

  const app = express();
  app.use(requestId, cookieParser());
  app.get('/me', authenticate, (req, res) => {
    res.json(req.user);
  });
  app.get('/pending-ok', authenticateAllowingPasswordChange, (req, res) => {
    res.json(req.user);
  });
  app.get('/teachers', authenticate, authorize('teachers:write'), (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/unauthenticated-guard', authorize('teachers:write'), (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);
  return app;
}

const login = () => tokens.issueSession({ userId: USER_ID, role: ROLES.PARENT, mustChangePassword: false });
const asCookie = (token: string) => `pa_access=${token}`;

describe('authenticate', () => {
  it('accepts a valid session and exposes the user', async () => {
    const session = await login();
    const res = await request(makeApp()).get('/me').set('Cookie', asCookie(session.accessToken));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: USER_ID,
      role: ROLES.PARENT,
      mustChangePassword: false,
      sessionId: session.sessionId,
    });
  });

  it('rejects a missing, garbage or header-only token', async () => {
    const session = await login();
    const app = makeApp();

    for (const req of [
      request(app).get('/me'),
      request(app).get('/me').set('Cookie', 'pa_access=garbage'),
      request(app).get('/me').set('Authorization', `Bearer ${session.accessToken}`),
    ]) {
      const res = await req;
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('asks for a refresh only when a genuine token has expired', async () => {
    const session = await login();
    clock += 16 * MINUTE;

    const res = await request(makeApp()).get('/me').set('Cookie', asCookie(session.accessToken));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('stops working the moment the login is revoked', async () => {
    const session = await login();
    await tokens.revokeSession(session.sessionId);

    const res = await request(makeApp()).get('/me').set('Cookie', asCookie(session.accessToken));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('takes the role from the database, not the token', async () => {
    const session = await login(); // token was issued as PARENT
    dbUser = { ...dbUser!, role: ROLES.TEACHER };

    const res = await request(makeApp()).get('/me').set('Cookie', asCookie(session.accessToken));
    expect(res.body.role).toBe(ROLES.TEACHER);
  });

  it('rejects deleted, invited and locked accounts', async () => {
    const session = await login();
    const cookie = asCookie(session.accessToken);
    const app = makeApp();

    dbUser = null;
    expect((await request(app).get('/me').set('Cookie', cookie)).body.error.code).toBe('UNAUTHENTICATED');

    dbUser = { id: USER_ID, role: ROLES.PARENT, status: USER_STATUS.INVITED, mustChangePassword: false };
    expect((await request(app).get('/me').set('Cookie', cookie)).body.error.code).toBe('UNAUTHENTICATED');

    dbUser = { ...dbUser, status: USER_STATUS.LOCKED };
    const locked = await request(app).get('/me').set('Cookie', cookie);
    expect(locked.status).toBe(403);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
  });

  it('blocks everything except the allowed routes while a password change is pending', async () => {
    const session = await login();
    dbUser = { ...dbUser!, mustChangePassword: true };
    const cookie = asCookie(session.accessToken);
    const app = makeApp();

    const blocked = await request(app).get('/me').set('Cookie', cookie);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    expect((await request(app).get('/pending-ok').set('Cookie', cookie)).status).toBe(200);
  });

  it('fails closed with 503 when the session store or the database is down', async () => {
    const session = await login();
    const cookie = asCookie(session.accessToken);
    const app = makeApp();

    memory.setDown(true);
    expect((await request(app).get('/me').set('Cookie', cookie)).status).toBe(503);

    memory.setDown(false);
    dbDown = true;
    expect((await request(app).get('/me').set('Cookie', cookie)).status).toBe(503);
  });
});

describe('authorize', () => {
  it('allows roles in the matrix and refuses the rest', async () => {
    const session = await login();
    const cookie = asCookie(session.accessToken);
    const app = makeApp();

    const parent = await request(app).get('/teachers').set('Cookie', cookie);
    expect(parent.status).toBe(403);
    expect(parent.body.error.code).toBe('FORBIDDEN');

    dbUser = { ...dbUser!, role: ROLES.ADMIN };
    expect((await request(app).get('/teachers').set('Cookie', cookie)).status).toBe(200);
  });

  it('denies a request that never went through authenticate', async () => {
    const res = await request(makeApp()).get('/unauthenticated-guard');

    expect(res.status).toBe(401);
  });
});