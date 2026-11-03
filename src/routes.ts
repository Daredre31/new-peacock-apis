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
import type { ExamJobs } from './jobs/exam.jobs';
import { createResultsModule } from './modules/results/results.module';
import { scoreRepository } from './modules/results/score.repository';
import { createCbtModule } from './modules/cbt/cbt.module';

export interface RouteDeps {
  health: HealthDependencies;
  auth: AuthModule;
  audit: AuditService;
  store: KeyValueStore;
  rateLimitRedis: RedisLike | null;
  mailer: Mailer;
  examJobs: ExamJobs;
}

export function createRoutes({ health, auth, audit, store, rateLimitRedis, mailer, examJobs }: RouteDeps): Router {
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
  // router.use(createSettingsModule({ audit, auth }).router);

    const settings = createSettingsModule({ audit, auth, assessmentInUse: () => scoreRepository.anyExists() });
  router.use(settings.router);
  router.use(createResultsModule({ audit, auth, scope: users.scope, notifier: communication.notifier, settings: settings.service, store }).router);
    router.use(
    createCbtModule({
      audit, auth, scope: users.scope, notifier: communication.notifier, settings: settings.service, store, jobs: examJobs,
    }).router,
  );
  // A route without authorize() or publicRoute() stops the app from starting.
  assertAllRoutesGuarded(router);
  return router;
}
