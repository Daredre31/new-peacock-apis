import type { CookieOptions, Response } from 'express';
import { AUTH_TTL } from '../../config/constants';
import { env, isProduction } from '../../config/env';

export const COOKIE_NAMES = {
  access: 'pa_access',
  refresh: 'pa_refresh',
  csrf: 'pa_csrf',
} as const;

export const REFRESH_COOKIE_PATH = '/api/v1/auth/refresh';

// Access and refresh cookies are host-only (no Domain), so they are sent to the API host and nowhere else.
const accessOptions: CookieOptions = {
  httpOnly: true,
  secure: isProduction,
  // Lax, not Strict, so a link in an email (for example a receipt PDF) still opens while logged in.
  sameSite: 'lax',
  path: '/api/v1',
};

const refreshOptions: CookieOptions = {
  httpOnly: true,
  secure: isProduction,
  // Only the frontend's own refresh call ever needs this one, so it can be Strict.
  sameSite: 'strict',
  path: REFRESH_COOKIE_PATH,
};

// The CSRF cookie must be readable by frontend JavaScript, and the frontend lives on a
// different subdomain in production, so this one (and only this one) gets the parent Domain.
const csrfOptions: CookieOptions = {
  httpOnly: false,
  secure: isProduction,
  sameSite: 'lax',
  path: '/',
  ...(env.COOKIE_DOMAIN && { domain: env.COOKIE_DOMAIN }),
};

export interface AuthCookieValues {
  accessToken: string;
  accessExpiresAt: Date;
  refreshToken: string;
  refreshExpiresAt: Date;
}

export function setAuthCookies(res: Response, values: AuthCookieValues): void {
  res.cookie(COOKIE_NAMES.access, values.accessToken, { ...accessOptions, expires: values.accessExpiresAt });
  res.cookie(COOKIE_NAMES.refresh, values.refreshToken, { ...refreshOptions, expires: values.refreshExpiresAt });
}

export function setCsrfCookie(res: Response, token: string): void {
  res.cookie(COOKIE_NAMES.csrf, token, { ...csrfOptions, maxAge: AUTH_TTL.refreshSeconds * 1000 });
}

/** Logout and force-logout. clearCookie only works with the same path and domain the cookie was set with. */
export function clearAuthCookies(res: Response): void {
  res.clearCookie(COOKIE_NAMES.access, accessOptions);
  res.clearCookie(COOKIE_NAMES.refresh, refreshOptions);
  res.clearCookie(COOKIE_NAMES.csrf, csrfOptions);
}