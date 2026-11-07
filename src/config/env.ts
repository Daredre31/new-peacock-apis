import dotenv from 'dotenv';
import { z } from 'zod';

// Tests load .env.test so they can never touch development data.
// dotenv never overrides variables already set, so real production
// environment variables always win over any .env file.
dotenv.config({
  path: process.env.NODE_ENV === 'test' ? '.env.test' : '.env',
  quiet: true,
});

const PLACEHOLDER = /change[-_ ]?me|your[-_ ]|placeholder|example|secret-here/i;

const isOrigin = (value: string): boolean => {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
};

const secret = z.string().min(32, 'must be at least 32 characters');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    MONGODB_URI: z
      .string()
      .regex(/^mongodb(\+srv)?:\/\//, 'must start with mongodb:// or mongodb+srv://'),
    REDIS_URL: z.string().regex(/^rediss?:\/\//, 'must start with redis:// or rediss://'),

    // Exact origin only: scheme + host (+ port), no path, no trailing slash.
    CORS_ORIGIN: z
      .string()
      .refine(isOrigin, 'must be an exact origin like http://localhost:5173 (no trailing slash)'),
    // Set to the parent domain in staging/production, e.g. .yourschool.com
    COOKIE_DOMAIN: z.string().optional(),
    // Number of reverse proxies in front of the API (needed for correct client IPs).
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
        // The API docs page. Defaults to on in development and test, off in production.
    DOCS_ENABLED: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),

          // Run the background workers inside the API process. Set to false to run them separately later.
    WORKERS_ENABLED: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),

    // Cloudinary stores the student passport photos. All three are needed for uploads to work;
    // without them the API still starts and the photo routes answer 503.
    CLOUDINARY_CLOUD_NAME: z.string().min(1).optional(),
    CLOUDINARY_API_KEY: z.string().min(1).optional(),
    CLOUDINARY_API_SECRET: z.string().min(1).optional(),

    // Resend sends the emails (reset links, notifications). Set both to turn it on.
    // Development without them prints emails to the console instead.
    RESEND_API_KEY: z.string().min(1).optional(),
    MAIL_FROM: z.string().min(3).optional(),

    ACCESS_TOKEN_SECRET: secret,
    REFRESH_TOKEN_SECRET: secret,
    CSRF_SECRET: secret,
  })
  .superRefine((cfg, ctx) => {
    const secrets = [cfg.ACCESS_TOKEN_SECRET, cfg.REFRESH_TOKEN_SECRET, cfg.CSRF_SECRET];
    if (new Set(secrets).size !== secrets.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['ACCESS_TOKEN_SECRET'],
        message: 'access, refresh and CSRF secrets must all be different',
      });
    }
    

    if (Boolean(cfg.RESEND_API_KEY) !== Boolean(cfg.MAIL_FROM)) {
      ctx.addIssue({
        code: 'custom',
        path: [cfg.RESEND_API_KEY ? 'MAIL_FROM' : 'RESEND_API_KEY'],
        message: 'RESEND_API_KEY and MAIL_FROM must be set together',
      });
    }

    if (cfg.NODE_ENV === 'production') {
      if (!cfg.CORS_ORIGIN.startsWith('https://')) {
        ctx.addIssue({
          code: 'custom',
          path: ['CORS_ORIGIN'],
          message: 'must be https in production',
        });
      }
      for (const key of ['ACCESS_TOKEN_SECRET', 'REFRESH_TOKEN_SECRET', 'CSRF_SECRET'] as const) {
        if (PLACEHOLDER.test(cfg[key])) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'looks like a placeholder value',
          });
        }
      }
    }
  })
      .transform((cfg) => ({
    ...cfg,
    DOCS_ENABLED: cfg.DOCS_ENABLED ?? cfg.NODE_ENV !== 'production',
    WORKERS_ENABLED: cfg.WORKERS_ENABLED ?? true,
  }));

export type Env = z.infer<typeof schema>;

function loadEnv(): Readonly<Env> {
  // Treat empty values (KEY=) as unset so defaults and required checks apply.
  const raw = Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => v !== undefined && v !== ''),
  );

  const result = schema.safeParse(raw);

  if (!result.success) {
    // Names and reasons only. Values are never printed, so secrets cannot leak.
    const lines = result.error.issues.map(
      (issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    process.stderr.write(
      `\nInvalid environment configuration:\n${lines.join('\n')}\n\nFix your environment and restart.\n`,
    );
    process.exit(1);
  }

  return Object.freeze(result.data);
}

export const env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';