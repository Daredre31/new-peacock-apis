import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// 43 characters of random nonce, a dot, then 43 characters of signature.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/;

export function createCsrfService(secret: string) {
  if (secret.length < 32) throw new Error('CSRF secret must be at least 32 characters');

  const sign = (nonce: string): string =>
    createHmac('sha256', secret).update(`csrf:${nonce}`).digest('base64url');

  const safeEqual = (a: string, b: string): boolean => {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  };

  const isValid = (token: unknown): token is string => {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return false;
    const [nonce = '', signature = ''] = token.split('.');
    return safeEqual(sign(nonce), signature);
  };

  return {
    generate(): string {
      const nonce = randomBytes(32).toString('base64url');
      return `${nonce}.${sign(nonce)}`;
    },

    isValid,

    /** Cookie and header must be identical, and the token must carry our signature. */
    matches(cookie: unknown, header: unknown): boolean {
      return isValid(cookie) && typeof header === 'string' && safeEqual(cookie, header);
    },
  };
}

export type CsrfService = ReturnType<typeof createCsrfService>;