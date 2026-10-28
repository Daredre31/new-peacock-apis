import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { isAppError } from '../../src/common/errors/AppError';
import { requestId } from '../../src/common/middleware/requestId';
import {
  createLoginRateLimiter,
  createRateLimiter,
  type RedisLike,
} from '../../src/common/middleware/rateLimiter';
import { sendError } from '../../src/common/utils/apiResponse';

function makeApp(limiter: RequestHandler) {
  const app = express();
  app.use(requestId);
  app.use(express.json());
  app.use(limiter);
  app.all('/probe', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (isAppError(err)) {
      sendError(res, err, req.id);
      return;
    }
    res.status(500).json({ error: 'unexpected' });
  });
  return app;
}

const base = {
  name: 'test',
  windowMs: 60_000,
  limit: 3,
  key: (req: Request) => req.get('x-key') ?? 'anon',
};

// Accepts the script load, then misbehaves on every real command.
function fakeRedis(mode: 'down' | 'hang'): RedisLike {
  return {
    call: (command) => {
      if (command.toUpperCase() === 'SCRIPT') return Promise.resolve('fake-sha');
      return mode === 'down'
        ? Promise.reject(new Error('redis down'))
        : new Promise<never>(() => {});
    },
  };
}

describe('rate limiter', () => {
  it('allows up to the limit, then returns RATE_LIMITED with retry info', async () => {
    const app = makeApp(createRateLimiter({ ...base, redis: null, onRedisFailure: 'fail-closed' }));

    for (let i = 0; i < 3; i += 1) {
      expect((await request(app).get('/probe')).status).toBe(200);
    }

    const blocked = await request(app).get('/probe');
    expect(blocked.status).toBe(429);
    expect(blocked.body.success).toBe(false);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(blocked.body.error.retryAfter).toBeGreaterThan(0);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(blocked.body.requestId).toBe(blocked.headers['x-request-id']);
  });

  it('counts each key separately', async () => {
    const app = makeApp(createRateLimiter({ ...base, redis: null, onRedisFailure: 'fail-closed' }));

    for (let i = 0; i < 3; i += 1) await request(app).get('/probe').set('X-Key', 'a');

    expect((await request(app).get('/probe').set('X-Key', 'a')).status).toBe(429);
    expect((await request(app).get('/probe').set('X-Key', 'b')).status).toBe(200);
  });

  it('does not count skipped paths', async () => {
    const app = makeApp(
      createRateLimiter({
        ...base,
        limit: 1,
        redis: null,
        onRedisFailure: 'fail-closed',
        skip: (req) => req.path === '/health',
      }),
    );

    for (let i = 0; i < 4; i += 1) {
      expect((await request(app).get('/health')).status).toBe(200);
    }
    expect((await request(app).get('/probe')).status).toBe(200);
    expect((await request(app).get('/probe')).status).toBe(429);
  });
});

describe('login rate limiter', () => {
  it('allows 5 attempts per email, then blocks that email only', async () => {
    const app = makeApp(createLoginRateLimiter(null));

    for (let i = 0; i < 5; i += 1) {
      expect((await request(app).post('/probe').send({ identifier: 'a@x.co' })).status).toBe(200);
    }

    expect((await request(app).post('/probe').send({ identifier: 'a@x.co' })).status).toBe(429);
    expect((await request(app).post('/probe').send({ identifier: 'b@x.co' })).status).toBe(200);
  });

  it('treats email case and spacing as the same account', async () => {
    const app = makeApp(createLoginRateLimiter(null));

    for (let i = 0; i < 5; i += 1) {
      await request(app).post('/probe').send({ identifier: 'a@x.co' });
    }

    const res = await request(app).post('/probe').send({ identifier: '  A@X.CO ' });
    expect(res.status).toBe(429);
  });
});

describe('when Redis fails', () => {
  it('fails closed with SERVICE_UNAVAILABLE', async () => {
    const app = makeApp(
      createRateLimiter({ ...base, redis: fakeRedis('down'), onRedisFailure: 'fail-closed' }),
    );

    const res = await request(app).get('/probe');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('can fall back to in-memory limiting', async () => {
    const app = makeApp(
      createRateLimiter({ ...base, limit: 2, redis: fakeRedis('down'), onRedisFailure: 'use-memory' }),
    );

    expect((await request(app).get('/probe')).status).toBe(200);
    expect((await request(app).get('/probe')).status).toBe(200);
    expect((await request(app).get('/probe')).status).toBe(429);
  });

  it('times out a hung Redis instead of hanging the request', async () => {
    const app = makeApp(
      createRateLimiter({
        ...base,
        redis: fakeRedis('hang'),
        onRedisFailure: 'fail-closed',
        redisTimeoutMs: 50,
      }),
    );

    const res = await request(app).get('/probe');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
  });
});