import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createCsrfMiddleware } from '../../src/common/middleware/csrf';
import { errorHandler } from '../../src/common/middleware/errorHandler';
import { requestId } from '../../src/common/middleware/requestId';
import { createCsrfService } from '../../src/modules/auth/csrf.service';

const csrf = createCsrfService('csrf-secret-for-tests-0123456789-abcdefgh');
const attacker = createCsrfService('attacker-secret-for-tests-0123456789-abcd');

const app = express();
app.use(requestId, cookieParser(), createCsrfMiddleware(csrf));
app.all('/x', (_req, res) => {
  res.json({ ok: true });
});
app.use(errorHandler);

const session = 'pa_access=abc';
const withToken = (token: string) => [session, `pa_csrf=${token}`];

describe('csrf protection', () => {
  it('blocks a state-changing request that has a session but no token', async () => {
    const res = await request(app).post('/x').set('Cookie', session);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_INVALID');
  });

  it('accepts a matching, correctly signed token on POST, PUT, PATCH and DELETE', async () => {
    const token = csrf.generate();

    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const res = await request(app)[method]('/x').set('Cookie', withToken(token)).set('X-CSRF-Token', token);
      expect(res.status, method).toBe(200);
    }
  });

  it('blocks a header that differs from the cookie', async () => {
    const res = await request(app)
      .post('/x')
      .set('Cookie', withToken(csrf.generate()))
      .set('X-CSRF-Token', csrf.generate());

    expect(res.status).toBe(403);
  });

  it('blocks a cookie-tossing attack: cookie and header match but the signature is not ours', async () => {
    const forged = attacker.generate();
    const res = await request(app).post('/x').set('Cookie', withToken(forged)).set('X-CSRF-Token', forged);

    expect(res.status).toBe(403);
  });

  it('blocks malformed tokens', async () => {
    const res = await request(app).post('/x').set('Cookie', withToken('abc')).set('X-CSRF-Token', 'abc');

    expect(res.status).toBe(403);
  });

  it('lets requests without session cookies through (login, forgot password)', async () => {
    expect((await request(app).post('/x')).status).toBe(200);
  });

  it('protects the refresh cookie too', async () => {
    const res = await request(app).post('/x').set('Cookie', 'pa_refresh=abc');

    expect(res.status).toBe(403);
  });

  it('hands a logged-in browser a fresh token on a GET, and only when it needs one', async () => {
    const missing = await request(app).get('/x').set('Cookie', session);
    expect(missing.status).toBe(200);
    expect(String(missing.headers['set-cookie'])).toContain('pa_csrf=');

    const valid = await request(app).get('/x').set('Cookie', withToken(csrf.generate()));
    expect(valid.headers['set-cookie']).toBeUndefined();

    const noSession = await request(app).get('/x');
    expect(noSession.headers['set-cookie']).toBeUndefined();
  });
});