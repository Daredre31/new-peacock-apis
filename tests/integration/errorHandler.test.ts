import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/common/errors/AppError';
import { errorHandler } from '../../src/common/middleware/errorHandler';
import { notFound } from '../../src/common/middleware/notFound';
import { requestId } from '../../src/common/middleware/requestId';

function makeApp() {
  const app = express();
  app.use(requestId);
  app.use(express.json({ limit: '1kb' }));

  app.get('/app-error', () => {
    throw new AppError('FORBIDDEN');
  });

  app.get('/with-details', () => {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'email', issue: 'Invalid email' }],
    });
  });

  app.get('/async-bug', async () => {
    await Promise.resolve();
    throw new Error('db password is hunter2 at mongodb://user:pw@host');
  });

  app.get('/mongo-duplicate', () => {
    throw Object.assign(new Error('E11000 duplicate key secret-value'), {
      name: 'MongoServerError',
      code: 11000,
    });
  });

  app.get('/client-error', () => {
    throw Object.assign(new Error('Failed to decode param'), { status: 400 });
  });

  app.post('/echo', (req, res) => {
    res.json({ ok: true, body: req.body as unknown });
  });

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

describe('notFound', () => {
  it('returns the standard envelope for unknown routes', async () => {
    const res = await request(makeApp()).get('/nothing-here');

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });
});

describe('errorHandler', () => {
  it('uses the code, status and requestId of an AppError', async () => {
    const res = await request(makeApp()).get('/app-error');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });

  it('includes validation details', async () => {
    const res = await request(makeApp()).get('/with-details');

    expect(res.status).toBe(422);
    expect(res.body.error.details).toEqual([{ field: 'email', issue: 'Invalid email' }]);
  });

  it('turns a thrown bug (even async) into INTERNAL_ERROR without leaking anything', async () => {
    const res = await request(makeApp()).get('/async-bug');

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('mongodb://');
    expect(text).not.toContain('stack');
    expect(res.body.requestId).toBeTruthy();
  });

  it('maps malformed JSON to a VALIDATION_ERROR', async () => {
    const res = await request(makeApp())
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send('{"email": ');

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toEqual([{ field: 'body', issue: 'Malformed JSON' }]);
  });

  it('rejects a body over the size limit', async () => {
    const res = await request(makeApp())
      .post('/echo')
      .send({ filler: 'x'.repeat(5000) });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toBe('Request body is too large');
  });

  it('maps a MongoDB duplicate key to CONFLICT without exposing the value', async () => {
    const res = await request(makeApp()).get('/mongo-duplicate');

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(JSON.stringify(res.body)).not.toContain('secret-value');
  });

  it('maps other client errors to VALIDATION_ERROR and not a 500', async () => {
    const res = await request(makeApp()).get('/client-error');

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('keeps working after an error (the app does not crash)', async () => {
    const app = makeApp();

    await request(app).get('/async-bug');
    const res = await request(app).post('/echo').send({ ok: 1 });

    expect(res.status).toBe(200);
  });
});