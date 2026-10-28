import type { RequestHandler } from 'express';
import { USER_STATUS, type Role, type UserStatus } from '../../config/constants';
import { COOKIE_NAMES } from '../../modules/auth/cookies';
import type { TokenService } from '../../modules/auth/token.service';
import { AppError } from '../errors/AppError';

export interface AuthUserRecord {
  id: string;
  role: Role;
  status: UserStatus;
  mustChangePassword: boolean;
}

export interface AuthMiddlewareDeps {
  tokens: Pick<TokenService, 'verifyAccessToken' | 'isSessionActive'>;
  /** The database is the source of truth for role and status, so changes take effect at once. */
  findUser: (id: string) => Promise<AuthUserRecord | null>;
  /** Runs last, after req.user is set, so the 300/min limit is counted per user. */
  userRateLimiter: RequestHandler;
}

export function createAuthMiddleware(deps: AuthMiddlewareDeps) {
  function build(options: { allowPasswordChangePending: boolean }): RequestHandler {
    return async (req, res, next) => {
      // Cookies only. An Authorization header is never read, so a token pasted into a
      // header, a URL or a script can't be used to get in.
      const cookies = req.cookies as Record<string, unknown> | undefined;
      const verification = await deps.tokens.verifyAccessToken(cookies?.[COOKIE_NAMES.access]);

      if (!verification.ok) {
        // "Expired" is the frontend's cue to call /auth/refresh once. Everything else means log in again.
        throw new AppError(verification.reason === 'expired' ? 'TOKEN_EXPIRED' : 'UNAUTHENTICATED');
      }
      const { claims } = verification;

      // Logout, force logout and refresh-token theft all end the login. This makes them instant.
      if (!(await deps.tokens.isSessionActive(claims))) throw new AppError('UNAUTHENTICATED');

      let user: AuthUserRecord | null;
      try {
        user = await deps.findUser(claims.userId);
      } catch (err) {
        throw new AppError('SERVICE_UNAVAILABLE', { cause: err });
      }

      if (!user) throw new AppError('UNAUTHENTICATED');
      if (user.status === USER_STATUS.LOCKED) throw new AppError('ACCOUNT_LOCKED');
      if (user.status !== USER_STATUS.ACTIVE) throw new AppError('UNAUTHENTICATED');
      if (user.mustChangePassword && !options.allowPasswordChangePending) {
        throw new AppError('PASSWORD_CHANGE_REQUIRED');
      }

      req.user = {
        id: user.id,
        role: user.role,
        mustChangePassword: user.mustChangePassword,
        sessionId: claims.sessionId,
      };
      req.log = req.log.child({ userId: user.id, role: user.role });

      deps.userRateLimiter(req, res, next);
    };
  }

  return {
    /** The default. Blocks everything while a password change is pending. */
    authenticate: build({ allowPasswordChangePending: false }),
    /** Only for /auth/me, logout, logout-all and change-password. */
    authenticateAllowingPasswordChange: build({ allowPasswordChangePending: true }),
  };
}