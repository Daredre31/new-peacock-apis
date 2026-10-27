import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express, type RequestHandler } from 'express';
import helmet from 'helmet';
import { errorHandler } from './common/middleware/errorHandler';
import { notFound } from './common/middleware/notFound';
import { createIpRateLimiter, type RedisLike } from './common/middleware/rateLimiter';
import { requestId } from './common/middleware/requestId';
import { env } from './config/env';
import type { HealthDependencies } from './modules/health/health.routes';
import { createRoutes } from './routes';
import { buildOpenApiDocument } from './openapi';
import { createDocsRouter } from './openapi/docs.routes';


export interface AppDependencies extends HealthDependencies {
  /** null means in-process memory limiting only. Meant for tests. */
  rateLimitRedis: RedisLike | null;
    /** Overrides env.DOCS_ENABLED. Meant for tests. */
  docsEnabled?: boolean;
}

// Responses carry personal and financial data, so nothing may be cached anywhere.
const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};

export function createApp(deps: AppDependencies): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('etag', false);
  // Without this, every client behind a reverse proxy shares the proxy's IP.
  app.set('trust proxy', env.TRUST_PROXY_HOPS);

  // Order follows the spec: requestId, helmet, cors, rateLimiter, JSON body, cookies, csrf, routes.
  app.use(requestId);
  app.use(noStore);

  app.use(
    helmet({
      // This is a JSON API, so it loads nothing and can be framed by nobody.
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  app.use(
    cors({
      origin: env.CORS_ORIGIN, // exact origin, never a wildcard
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'X-Request-Id', 'Idempotency-Key'],
      exposedHeaders: ['X-Request-Id', 'Retry-After'],
      maxAge: 600,
    }),
  );

    if (deps.docsEnabled ?? env.DOCS_ENABLED) {
    app.use('/api/docs', createDocsRouter(buildOpenApiDocument()));
  }

  app.use(createIpRateLimiter(deps.rateLimitRedis));

  // Phase 4: the Paystack webhook mounts HERE, before the JSON parser, so it can read the raw body.

  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  // Phase 1: csrf middleware mounts HERE.

  app.use('/api/v1', createRoutes(deps));

  app.use(notFound);
  app.use(errorHandler);

  return app;
}