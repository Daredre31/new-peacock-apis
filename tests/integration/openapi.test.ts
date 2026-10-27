import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApp } from '../../src/app';
import { buildDocument, type OpenApiDocument } from '../../src/openapi/builder';
import { buildOpenApiDocument } from '../../src/openapi';
import { OpenApiRegistry } from '../../src/openapi/registry';
import { healthDataSchema, readyDataSchema } from '../../src/modules/health/health.schema';

const healthy = () => Promise.resolve({ ok: true, latencyMs: 1 });

function makeApp(docsEnabled = true) {
  return createApp({ rateLimitRedis: null, checkMongo: healthy, checkRedis: healthy, docsEnabled });
}

function sampleDocument(): OpenApiDocument {
  const registry = new OpenApiRegistry();
  registry.register({
    method: 'post',
    path: '/students/{id}/links',
    operationId: 'createLink',
    summary: 'Link a parent',
    tags: ['students'],
    roles: ['SUPER_ADMIN', 'ADMIN'],
    request: {
      params: z.object({ id: z.string() }),
      query: z.object({ note: z.string().optional() }),
      body: z.object({ relationship: z.string().min(1) }),
    },
    success: { status: 201, description: 'Created', data: z.object({ id: z.string() }) },
    errors: ['NOT_FOUND', 'CONFLICT'],
  });
  return buildDocument(registry);
}

describe('document builder', () => {
  it('builds an OpenAPI 3.1 document under /api/v1', () => {
    const doc = buildOpenApiDocument();

    expect(doc.openapi).toBe('3.1.0');
    expect(doc.servers).toEqual([{ url: '/api/v1' }]);
    expect(Object.keys(doc.paths)).toEqual(['/health', '/ready']);
  });

  it('publishes x-roles, empty for public routes', () => {
    expect(buildOpenApiDocument().paths['/health']?.get?.['x-roles']).toEqual([]);
    expect(sampleDocument().paths['/students/{id}/links']?.post?.['x-roles']).toEqual([
      'SUPER_ADMIN',
      'ADMIN',
    ]);
  });

  it('describes parameters, body and responses', () => {
    const op = sampleDocument().paths['/students/{id}/links']?.post;

    expect(op?.parameters).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
      { name: 'note', in: 'query', required: false, schema: { type: 'string' } },
    ]);
    expect(op?.requestBody?.content['application/json'].schema.properties).toHaveProperty(
      'relationship',
    );
    expect(Object.keys(op?.responses ?? {})).toEqual(
      expect.arrayContaining(['201', '401', '403', '404', '409', '422', '429', '500']),
    );
  });

  it('adds auth and CSRF errors only to protected, state-changing routes', () => {
    const doc = sampleDocument();
    expect(doc.paths['/students/{id}/links']?.post?.responses['403']?.description).toContain(
      'CSRF_INVALID',
    );
    expect(buildOpenApiDocument().paths['/health']?.get?.responses['403']).toBeUndefined();
  });

  it('only uses $ref to point at existing components', () => {
    const doc = buildOpenApiDocument();
    const refs = [...JSON.stringify(doc).matchAll(/"\$ref":"([^"]+)"/g)].map((m) => m[1] ?? '');

    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.startsWith('#/components/schemas/')).toBe(true);
      expect(doc.components.schemas[ref.split('/').pop() ?? '']).toBeDefined();
    }
  });

  it('is deterministic', () => {
    expect(JSON.stringify(buildOpenApiDocument())).toBe(JSON.stringify(buildOpenApiDocument()));
  });

  it('rejects duplicate operations', () => {
    const registry = new OpenApiRegistry();
    const spec = {
      method: 'get' as const,
      path: '/x',
      operationId: 'x',
      summary: 'x',
      tags: ['t'],
      success: { status: 200, description: 'ok', data: z.object({}) },
    };
    registry.register(spec);

    expect(() => registry.register(spec)).toThrow('Duplicate OpenAPI operation');
  });

  it('fails loudly on a schema it cannot describe', () => {
    const registry = new OpenApiRegistry();
    registry.register({
      method: 'get',
      path: '/x',
      operationId: 'x',
      summary: 'x',
      tags: ['t'],
      success: { status: 200, description: 'ok', data: z.object({ at: z.date() }) },
    });

    expect(() => buildDocument(registry)).toThrow();
  });

  it('fails when path placeholders and the params schema disagree', () => {
    const registry = new OpenApiRegistry();
    registry.register({
      method: 'get',
      path: '/items/{id}',
      operationId: 'getItem',
      summary: 'x',
      tags: ['t'],
      success: { status: 200, description: 'ok', data: z.object({}) },
    });

    expect(() => buildDocument(registry)).toThrow('do not match');
  });
});

describe('contract matches the real responses', () => {
  it('health and ready payloads parse with their schemas', async () => {
    const app = makeApp();

    const health = await request(app).get('/api/v1/health');
    expect(healthDataSchema.safeParse(health.body.data).success).toBe(true);

    const ready = await request(app).get('/api/v1/ready');
    expect(readyDataSchema.safeParse(ready.body.data).success).toBe(true);
  });
});

describe('docs routes', () => {
  it('serves the spec at /api/docs/openapi.json', async () => {
    const res = await request(makeApp()).get('/api/docs/openapi.json');

    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(res.body.paths['/health']).toBeDefined();
  });

  it('serves the browsable page with its own CSP', async () => {
    const res = await request(makeApp()).get('/api/docs');

    expect(res.status).toBe(200);
    expect(res.text).toContain('swagger-ui');
    expect(res.headers['content-security-policy']).toContain('cdn.jsdelivr.net');
  });

  it('serves the init script as JavaScript', async () => {
    const res = await request(makeApp()).get('/api/docs/init.js');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('javascript');
  });

  it('keeps the strict CSP on the API itself', async () => {
    const res = await request(makeApp()).get('/api/v1/health');

    expect(res.headers['content-security-policy']).not.toContain('jsdelivr');
  });

  it('returns 404 when docs are disabled', async () => {
    const app = makeApp(false);

    expect((await request(app).get('/api/docs/openapi.json')).status).toBe(404);
    expect((await request(app).get('/api/docs')).status).toBe(404);
  });
});