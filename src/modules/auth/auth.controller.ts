import type { Request, RequestHandler } from 'express';
import { AppError } from '../../common/errors/AppError';
import type { Validated } from '../../common/middleware/validate';
import { sendSuccess } from '../../common/utils/apiResponse';
import type { AuthService, RequestContext } from './auth.service';
// import type { loginSchemas } from './auth.schema';
import { clearAuthCookies, COOKIE_NAMES, setAuthCookies, setCsrfCookie } from './cookies';
import type { changePasswordSchemas, loginSchemas, resetPasswordSchemas, forgotPasswordSchemas } from './auth.schema';
import type { CredentialsService } from './credentials.service';
// import { createCredentialsService } from './credentials.service'; // not needed here, remove if you only use the type
import type { CsrfService } from './csrf.service';

const contextOf = (req: Request): RequestContext => ({ ip: req.ip ?? 'unknown', requestId: req.id });

function requireUser(req: Request): Express.AuthUser {
  if (!req.user) throw new AppError('UNAUTHENTICATED');
  return req.user;
}

export function createAuthController(deps: { service: AuthService; credentials: CredentialsService; csrf: CsrfService }) {
  const { service, credentials, csrf } = deps;

  const login: RequestHandler = async (req, res) => {
    const { body } = req.validated as Validated<typeof loginSchemas>;
    const { user, session } = await service.login({ ...body, ...contextOf(req) });

    setAuthCookies(res, session);
    setCsrfCookie(res, csrf.generate());
    sendSuccess(res, { user });
  };

  const refresh: RequestHandler = async (req, res) => {
    const cookies = req.cookies as Record<string, unknown> | undefined;
    const result = await service.refresh(cookies?.[COOKIE_NAMES.refresh], contextOf(req));

    if (result.kind === 'retry') {
      // The browser already holds the new cookies from the request that won. Keep them.
      throw new AppError('CONFLICT', { message: 'Your session was just refreshed. Please retry.' });
    }
    if (result.kind === 'denied') {
      clearAuthCookies(res);
      throw new AppError('UNAUTHENTICATED');
    }

    setAuthCookies(res, result.session);
    setCsrfCookie(res, csrf.generate());
    sendSuccess(res, { user: result.user });
  };

  const logout: RequestHandler = async (req, res) => {
    await service.logout(requireUser(req), contextOf(req));
    clearAuthCookies(res);
    sendSuccess(res, null);
  };

  const logoutAll: RequestHandler = async (req, res) => {
    await service.logoutAll(requireUser(req).id, contextOf(req));
    clearAuthCookies(res);
    sendSuccess(res, null);
  };

  const me: RequestHandler = async (req, res) => {
    sendSuccess(res, { user: await service.getCurrentUser(requireUser(req).id) });
  };
    const changePassword: RequestHandler = async (req, res) => {
    const user = requireUser(req);
    const { body } = req.validated as Validated<typeof changePasswordSchemas>;
    const { session } = await credentials.changePassword({ userId: user.id, ...body, ...contextOf(req) });

    setAuthCookies(res, session);
    setCsrfCookie(res, csrf.generate());
    sendSuccess(res, { user: await service.getCurrentUser(user.id) });
  };

  const forgotPassword: RequestHandler = (req, res) => {
    const { body } = req.validated as Validated<typeof forgotPasswordSchemas>;
    const context = contextOf(req);

    // Answer first and work afterwards, so response time can never reveal whether an account exists.
    sendSuccess(res, null);
    credentials
      .requestPasswordReset({ identifier: body.identifier, ...context })
      .catch((err: unknown) => req.log.error({ err }, 'password reset request failed'));
  };

  const resetPassword: RequestHandler = async (req, res) => {
    const { body } = req.validated as Validated<typeof resetPasswordSchemas>;
    await credentials.resetPassword({ ...body, ...contextOf(req) });

    clearAuthCookies(res);
    sendSuccess(res, null);
  };

  return { login, refresh, logout, logoutAll, me, changePassword, forgotPassword, resetPassword };
}
