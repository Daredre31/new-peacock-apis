import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { requestId } from '../../src/common/middleware/requestId';

function makeApp() {
  const app = express();
  app.use(requestId);
  app.get('/probe', (req, res) => {
    res.json({ id: req.id, loggerId: req.log.bindings().requestId });
  });
  return app;
}

describe('requestId middleware', () => {
  it('generates an id and returns it in the header', async () => {
    const res = await request(makeApp()).get('/probe');

    const headerId = res.headers['x-request-id'];
    expect(headerId).toBeTruthy();
    expect(res.body.id).toBe(headerId);
    expect(res.body.loggerId).toBe(headerId);
  });

  it('accepts a safe id from the client', async () => {
    const res = await request(makeApp()).get('/probe').set('X-Request-Id', 'trace-abc_12345');

    expect(res.headers['x-request-id']).toBe('trace-abc_12345');
    expect(res.body.id).toBe('trace-abc_12345');
  });

  it('replaces an id that is too short', async () => {
    const res = await request(makeApp()).get('/probe').set('X-Request-Id', 'abc');

    expect(res.headers['x-request-id']).not.toBe('abc');
    expect(res.body.id).toBe(res.headers['x-request-id']);
  });

  it('replaces an id with unsafe characters', async () => {
    const res = await request(makeApp()).get('/probe').set('X-Request-Id', 'bad id <script>1');

    expect(res.headers['x-request-id']).not.toContain('<');
    expect(res.headers['x-request-id']).not.toContain(' ');
  });

  it('gives different ids to different requests', async () => {
    const app = makeApp();
    const a = await request(app).get('/probe');
    const b = await request(app).get('/probe');

    expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
  });
});