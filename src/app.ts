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
import { createCsrfMiddleware } from './common/middleware/csrf';
import { createAuthModule } from './modules/auth/auth.module';
import type { KeyValueStore } from './modules/auth/keyValueStore';
import { createAuditService } from './modules/audit/audit.service';
import { createImageStore, type ImageStore } from './integrations/imageStore';
import { createMailer, type Mailer } from './integrations/mailer';
import { createExamJobs } from './jobs/exam.jobs'; 
import type { ExamJobs } from './jobs/exam.jobs';
import { createReportJobs , type ReportJobs } from './jobs/report.jobs';
import { createPaymentJobs, type PaymentJobs } from './jobs/payment.jobs';



export interface AppDependencies extends HealthDependencies {
  /** null means in-process memory limiting only. Meant for tests. */
  rateLimitRedis: RedisLike | null;
    /** Overrides env.DOCS_ENABLED. Meant for tests. */
  docsEnabled?: boolean;
  sessionStore: KeyValueStore,
  mailer?: Mailer;
  /** Overrides the Cloudinary store. Meant for tests. */
  images?: ImageStore;
  examJobs?: ExamJobs;
  reportJobs?: ReportJobs;
  paymentJobs?: PaymentJobs;
}

// Responses carry personal and financial data, so nothing may be cached anywhere.
const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};

export function createApp(deps: AppDependencies): Express {
  const app = express();
  const audit = createAuditService()
  const mailer = deps.mailer ?? createMailer();
  const auth = createAuthModule({ sessionStore: deps.sessionStore, rateLimitRedis: 
               deps.rateLimitRedis, audit , mailer});

  const api = createRoutes({
    health: deps, auth, audit, store: deps.sessionStore, rateLimitRedis: deps.rateLimitRedis, mailer,
    images: deps.images ?? createImageStore(),
    examJobs: deps.examJobs ?? createExamJobs(null), reportJobs: deps.reportJobs ?? createReportJobs(null),
    paymentJobs: deps.paymentJobs ?? createPaymentJobs(null),
  });
    

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

  // Paystack calls this. It needs the raw bytes for the signature, so it comes BEFORE the JSON parser.
  // It has no cookies, so CSRF never applies. The signature is the only authentication.
  app.post('/api/v1/payments/webhook/paystack', express.raw({ type: '*/*', limit: '100kb' }), api.paystackWebhook);

  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

    app.use(createCsrfMiddleware(auth.csrf));

  app.use('/api/v1', api.router);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}