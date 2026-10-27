/** Contract version. Additive change = minor bump, breaking change = new /api/v2. */
export const OPENAPI_INFO = {
  title: 'Peacock Academy API',
  version: '0.1.0',
  description:
    'Contract for the Peacock Academy school management system. ' +
    'Every response uses the standard envelope; the frontend switches on error.code, never on message.',
} as const;