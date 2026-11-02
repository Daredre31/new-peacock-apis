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
import type { Mailer } from './integrations/mailer';
import { createCommunicationModule } from './modules/communication/communication.module';
import { createTasksModule } from './modules/tasks/tasks.module';
import { createSettingsModule } from './modules/settings/settings.module';

export interface RouteDeps {
  health: HealthDependencies;
  auth: AuthModule;
  audit: AuditService;
  store: KeyValueStore;
  rateLimitRedis: RedisLike | null;
  mailer: Mailer;
}

export function createRoutes({ health, auth, audit, store, rateLimitRedis, mailer }: RouteDeps): Router {
  const router = Router();

  router.use(createHealthRouter(health));
  router.use('/auth', auth.router);
  router.use('/audit-logs', createAuditRouter({ service: audit, authenticate: auth.middleware.authenticate }));

  const academics = createAcademicsModule({ audit, auth, store });
  router.use(academics.router);
  router.use(createUsersModule({ audit, auth, store, rateLimitRedis, teacherArms: academics.teacherArms }).router);
    const users = createUsersModule({ audit, auth, store, rateLimitRedis, teacherArms: academics.teacherArms });
  router.use(users.router);
    const communication = createCommunicationModule({
    audit, auth, mailer, scope: users.scope, armIdsOfUser: users.armIdsOfUser, teacherArms: academics.teacherArms,
  });
  router.use(communication.router);
  router.use(createTasksModule({ audit, auth, scope: users.scope, notifier: communication.notifier }).router);
  router.use(createSettingsModule({ audit, auth }).router);

  // A route without authorize() or publicRoute() stops the app from starting.
  assertAllRoutesGuarded(router);
  return router;
}
