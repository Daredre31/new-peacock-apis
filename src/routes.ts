import { Router } from 'express';
import { assertAllRoutesGuarded } from './common/middleware/routeGuards';
import type { RedisLike } from './common/middleware/rateLimiter';
import { createAcademicsModule } from './modules/academics/academics.module';
import { createAuditRouter } from './modules/audit/audit.routes';
import type { AuditService } from './modules/audit/audit.service';
import type { AuthModule } from './modules/auth/auth.module';
import type { KeyValueStore } from './modules/auth/keyValueStore';
import { createHealthRouter, type HealthDependencies } from './modules/health/health.routes';
import { createUsersModule } from './modules/users/users.module';

export interface RouteDeps {
  health: HealthDependencies;
  auth: AuthModule;
  audit: AuditService;
  store: KeyValueStore;
  rateLimitRedis: RedisLike | null;
}

export function createRoutes({ health, auth, audit, store, rateLimitRedis }: RouteDeps): Router {
  const router = Router();

  router.use(createHealthRouter(health));
  router.use('/auth', auth.router);
  router.use('/audit-logs', createAuditRouter({ service: audit, authenticate: auth.middleware.authenticate }));

  const academics = createAcademicsModule({ audit, auth, store });
  router.use(academics.router);
  router.use(createUsersModule({ audit, auth, store, rateLimitRedis, teacherArms: academics.teacherArms }).router);

  // A route without authorize() or publicRoute() stops the app from starting.
  assertAllRoutesGuarded(router);
  return router;
}