import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp, type AppDependencies } from '../../src/app';
import { env } from '../../src/config/env';
import { createMemoryStore } from '../helpers/memoryStore';

const healthy = () => Promise.resolve({ ok: true, latencyMs: 1 });
const down = () => Promise.resolve({ ok: false, latencyMs: 0 });

function makeApp(overrides: Partial<AppDependencies> = {}) {
  return createApp({
    rateLimitRedis: null,
    sessionStore: createMemoryStore(Date.now).store,
    checkMongo: healthy,
    checkRedis: healthy,
    ...overrides,
  });
}

describe('health endpoints', () => {
  it('GET /api/v1/health returns the standard envelope and a request id', async () => {
    const res = await request(makeApp()).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('ok');
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('GET /api/v1/ready is 200 when MongoDB and Redis are healthy', async () => {
    const res = await request(makeApp()).get('/api/v1/ready');

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ready');
  });

  it('GET /api/v1/ready is 503 when MongoDB is down, without saying which dependency', async () => {
    const res = await request(makeApp({ checkMongo: down })).get('/api/v1/ready');

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(JSON.stringify(res.body).toLowerCase()).not.toContain('mongo');
  });

  it('GET /api/v1/ready is 503 when Redis is down', async () => {
    const res = await request(makeApp({ checkRedis: down })).get('/api/v1/ready');

    expect(res.status).toBe(503);
  });

  it('treats a health check that throws as unhealthy and does not crash', async () => {
    const app = makeApp({ checkRedis: () => Promise.reject(new Error('boom')) });

    expect((await request(app).get('/api/v1/ready')).status).toBe(503);
    expect((await request(app).get('/api/v1/health')).status).toBe(200);
  });
});

describe('security headers', () => {
  it('sets hardening headers and hides the framework', async () => {
    const res = await request(makeApp()).get('/api/v1/health');

    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['etag']).toBeUndefined();
  });
});

describe('error handling through the full stack', () => {
  it('returns the envelope for unknown routes', async () => {
    const res = await request(makeApp()).get('/api/v1/nothing-here');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });

  it('returns the envelope for malformed JSON', async () => {
    const res = await request(makeApp())
      .post('/api/v1/anything')
      .set('Content-Type', 'application/json')
      .send('{"a": ');

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects bodies over 100 kb', async () => {
    const res = await request(makeApp())
      .post('/api/v1/anything')
      .send({ filler: 'x'.repeat(120_000) });

    expect(res.status).toBe(422);
    expect(res.body.error.message).toBe('Request body is too large');
  });
});

describe('CORS', () => {
  it('allows the configured origin with credentials', async () => {
    const res = await request(makeApp()).get('/api/v1/health').set('Origin', env.CORS_ORIGIN);

    expect(res.headers['access-control-allow-origin']).toBe(env.CORS_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('answers preflight requests and allows the CSRF header', async () => {
    const res = await request(makeApp())
      .options('/api/v1/health')
      .set('Origin', env.CORS_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'x-csrf-token,content-type');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-headers']?.toLowerCase()).toContain('x-csrf-token');
  });

  it('never grants access to another origin', async () => {
    const res = await request(makeApp())
      .get('/api/v1/health')
      .set('Origin', 'https://evil.example.com');

    expect(res.headers['access-control-allow-origin']).not.toBe('https://evil.example.com');
    expect(res.headers['access-control-allow-origin']).not.toBe('*');
  });
});