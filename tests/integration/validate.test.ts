import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../../src/common/errors/AppError';
import { validate } from '../../src/common/middleware/validate';

function makeApp() {
  const app = express();
  app.use(express.json());

  app.post(
    '/users',
    validate({
      body: z.object({ email: z.email(), age: z.number().int().min(0) }),
      query: z.object({ page: z.coerce.number().int().min(1).default(1) }),
    }),
    (req, res) => {
      res.json(req.validated);
    },
  );

  app.get('/bare', validate({}), (req, res) => {
    res.json(req.validated);
  });

  app.get(
    '/items/:id',
    validate({ params: z.object({ id: z.string().regex(/^[a-f0-9]{24}$/) }) }),
    (req, res) => {
      res.json(req.validated);
    },
  );

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ code: err.code, details: err.details });
      return;
    }
    res.status(500).json({ code: 'INTERNAL_ERROR' });
  });

  return app;
}

const fieldsOf = (body: { details?: { field: string }[] }) =>
  (body.details ?? []).map((d) => d.field);

describe('validate middleware', () => {
  it('passes valid input, coerces query values and applies defaults', async () => {
    const app = makeApp();

    const res = await request(app).post('/users?page=2').send({ email: 'a@b.co', age: 5 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ body: { email: 'a@b.co', age: 5 }, query: { page: 2 }, params: {} });

    const defaulted = await request(app).post('/users').send({ email: 'a@b.co', age: 5 });
    expect(defaulted.body.query).toEqual({ page: 1 });
  });

  it('rejects unknown body fields', async () => {
    const res = await request(makeApp())
      .post('/users')
      .send({ email: 'a@b.co', age: 5, role: 'admin' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details).toContainEqual({ field: 'role', issue: 'Unknown field' });
  });

  it('lists every missing field', async () => {
    const res = await request(makeApp()).post('/users').send({});

    expect(res.status).toBe(422);
    expect(fieldsOf(res.body)).toEqual(expect.arrayContaining(['email', 'age']));
  });

  it('reports problems from body and query together', async () => {
    const res = await request(makeApp()).post('/users?page=0&foo=1').send({});

    expect(res.status).toBe(422);
    expect(fieldsOf(res.body)).toEqual(expect.arrayContaining(['email', 'age', 'page', 'foo']));
  });

  it('rejects $ operators in the body', async () => {
    const res = await request(makeApp())
      .post('/users')
      .send({ email: { $ne: null }, age: 1 });

    expect(res.status).toBe(422);
    expect(res.body.details).toEqual([{ field: 'email.$ne', issue: 'Invalid key' }]);
  });

  it('rejects keys that contain a dot', async () => {
    const res = await request(makeApp())
      .post('/users')
      .send({ 'a.b': 1, email: 'a@b.co', age: 1 });

    expect(res.status).toBe(422);
    expect(res.body.details).toContainEqual({ field: 'a.b', issue: 'Invalid key' });
  });

  it('rejects __proto__ keys', async () => {
    const res = await request(makeApp())
      .post('/users')
      .set('Content-Type', 'application/json')
      .send('{"__proto__":{"admin":true},"email":"a@b.co","age":1}');

    expect(res.status).toBe(422);
    expect(res.body.details).toContainEqual({ field: '__proto__', issue: 'Invalid key' });
  });

  it('rejects absurdly deep nesting', async () => {
    let nested: Record<string, unknown> = {};
    for (let i = 0; i < 12; i += 1) nested = { a: nested };

    const res = await request(makeApp())
      .post('/users')
      .send({ email: 'a@b.co', age: 1, extra: nested });

    expect(res.status).toBe(422);
    expect(res.body.details[0].issue).toBe('Too deeply nested');
  });

  it('rejects query keys on a route that declares none', async () => {
    const app = makeApp();

    const bad = await request(app).get('/bare?foo=1');
    expect(bad.status).toBe(422);
    expect(bad.body.details).toContainEqual({ field: 'foo', issue: 'Unknown field' });

    const ok = await request(app).get('/bare');
    expect(ok.status).toBe(200);
  });

  it('validates route params', async () => {
    const app = makeApp();

    const bad = await request(app).get('/items/123');
    expect(bad.status).toBe(422);
    expect(fieldsOf(bad.body)).toContain('id');

    const id = 'a'.repeat(24);
    const ok = await request(app).get(`/items/${id}`);
    expect(ok.status).toBe(200);
    expect(ok.body.params).toEqual({ id });
  });

  it('never echoes the values the client sent', async () => {
    const res = await request(makeApp())
      .post('/users')
      .send({ email: 'a@b.co', age: 'hunter2-secret' });

    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).not.toContain('hunter2-secret');
  });

  it('handles a request with no body without crashing', async () => {
    const res = await request(makeApp()).post('/users');

    expect(res.status).toBe(422);
    expect(fieldsOf(res.body)).toEqual(expect.arrayContaining(['email', 'age']));
  });
});