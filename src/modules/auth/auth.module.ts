import { createAuthMiddleware } from '../../common/middleware/authenticate';
import {
  createLoginRateLimiter,
  createUserRateLimiter,
  type RedisLike,
} from '../../common/middleware/rateLimiter';
import { env } from '../../config/env';
import { userRepository } from '../users/user.repository';
import { createAuthController } from './auth.controller';
import { createAuthRouter } from './auth.routes';
import { createAuthService } from './auth.service';
import { createCsrfService } from './csrf.service';
import type { KeyValueStore } from './keyValueStore';
import { passwordService } from './password.service';
import { createTokenService } from './token.service';
import type { AuditPort } from '../audit/audit.port';

export interface AuthModuleDeps {
  sessionStore: KeyValueStore;
  rateLimitRedis: RedisLike | null;
  audit: AuditPort;
}

export function createAuthModule(deps: AuthModuleDeps) {
  const tokens = createTokenService({
    store: deps.sessionStore,
    accessSecret: env.ACCESS_TOKEN_SECRET,
    refreshSecret: env.REFRESH_TOKEN_SECRET,
  });
  const csrf = createCsrfService(env.CSRF_SECRET);
  const service = createAuthService({
    users: userRepository,
    passwords: passwordService,
    tokens,
   audit: deps.audit,
  });

  const middleware = createAuthMiddleware({
    tokens,
    findUser: (id) => userRepository.findById(id),
    userRateLimiter: createUserRateLimiter(deps.rateLimitRedis),
  });

  const router = createAuthRouter({
    controller: createAuthController({ service, csrf }),
    authenticateAllowingPasswordChange: middleware.authenticateAllowingPasswordChange,
    loginLimiter: createLoginRateLimiter(deps.rateLimitRedis),
  });

  // Other modules import authenticate from here when they get their routes.
  return { tokens, csrf, service, middleware, router };
}

export type AuthModule = ReturnType<typeof createAuthModule>;