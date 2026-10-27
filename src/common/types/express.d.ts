import type { Logger } from 'pino';
import type { Role } from '../../config/constants';

declare global {
  namespace Express {
    /** The caller, as established by the authenticate middleware (Phase 1). */
    interface AuthUser {
      id: string;
      role: Role;
      mustChangePassword: boolean;
      /** Refresh-token family of this login, used by logout and force-logout. */
      sessionId: string;
    }

    interface Request {
      /** Unique id for this request. Also sent back in the X-Request-Id header. */
      id: string;
      /** Logger that already carries this request's id. */
      log: Logger;
      /** Input that passed validation. Controllers read only this, never body, query or params. */
      validated: { body?: unknown; query?: unknown; params?: unknown };
      /** Undefined until authenticate has run. Public routes never have it. */
      user?: AuthUser;
    }
  }
}

export {};