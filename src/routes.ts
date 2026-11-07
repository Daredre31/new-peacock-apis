import { Router, type RequestHandler } from 'express';
import { assertAllRoutesGuarded } from './common/middleware/routeGuards';
import type { RedisLike } from './common/middleware/rateLimiter';
import type { ExamJobs } from './jobs/exam.jobs';
import type { PaymentJobs } from './jobs/payment.jobs';
import type { ReportJobs } from './jobs/report.jobs';
import type { ImageStore } from './integrations/imageStore';
import type { Mailer } from './integrations/mailer';
import { createAcademicsModule } from './modules/academics/academics.module';
import { createAuditRouter } from './modules/audit/audit.routes';
import type { AuditService } from './modules/audit/audit.service';
import type { AuthModule } from './modules/auth/auth.module';
import type { KeyValueStore } from './modules/auth/keyValueStore';
import { createCbtModule } from './modules/cbt/cbt.module';
import { createCommunicationModule } from './modules/communication/communication.module';
import { createHealthRouter, type HealthDependencies } from './modules/health/health.routes';
import { createPassportPhotosModule } from './modules/passport-photos/passportPhotos.module';
import { createPortalModule } from './modules/portal/portal.module';
import { createResultsModule } from './modules/results/results.module';
import { scoreRepository } from './modules/results/score.repository';
import { createSettingsModule } from './modules/settings/settings.module';
import { createTasksModule } from './modules/tasks/tasks.module';
import { createUsersModule } from './modules/users/users.module';
import { userRepository } from './modules/users/user.repository';
import { ROLES } from './config/constants';
import { createFeesModule } from './modules/fees/fees.module';

export interface RouteDeps {
  health: HealthDependencies;
  auth: AuthModule;
  audit: AuditService;
  store: KeyValueStore;
  rateLimitRedis: RedisLike | null;
  mailer: Mailer;
  images: ImageStore;
  examJobs: ExamJobs;
  reportJobs: ReportJobs;
  paymentJobs: PaymentJobs;
}

export function createRoutes({ health, auth, audit, store, rateLimitRedis, mailer, images, examJobs, reportJobs, paymentJobs }: RouteDeps): {
  router: Router;
  /** Mounted by app.ts before the JSON parser, because the signature is made over the raw bytes. */
  paystackWebhook: RequestHandler;
} {
  const router = Router();

  router.use(createHealthRouter(health));
  router.use('/auth', auth.router);
  router.use('/audit-logs', createAuditRouter({ service: audit, authenticate: auth.middleware.authenticate }));

  const academics = createAcademicsModule({ audit, auth, store });
  router.use(academics.router);

  // Settings come before the modules that read them, and that includes users (the student password rule).
  const settings = createSettingsModule({
    audit, auth,
    assessmentInUse: () => scoreRepository.anyExists(),
    onStudentPasswordChangeOff: () => userRepository.clearMustChangePasswordForRole(ROLES.STUDENT),
  });
  router.use(settings.router);

  const users = createUsersModule({ audit, auth, store, rateLimitRedis, teacherArms: academics.teacherArms, images, settings: settings.service });
  router.use(users.router);

  const communication = createCommunicationModule({
    audit, auth, mailer, scope: users.scope, armIdsOfUser: users.armIdsOfUser, teacherArms: academics.teacherArms, settings: settings.service,
  });
  router.use(communication.router);

  const fees = createFeesModule({
    audit, auth, scope: users.scope, notifier: communication.notifier, events: communication.events,
    requestChecks: communication.requestChecks, settings: settings.service, paymentJobs,
  });
  router.use(fees.router);

  // Students and parents propose a passport photo, an admin approves it.
  router.use(createPassportPhotosModule({ audit, auth, scope: users.scope, notifier: communication.notifier, images }).router);

  const tasks = createTasksModule({ audit, auth, scope: users.scope, notifier: communication.notifier });
  router.use(tasks.router);

  const results = createResultsModule({
    audit, auth, scope: users.scope, notifier: communication.notifier, settings: settings.service, store,
    reportGate: fees.reportGate,
  });
  router.use(results.router);

  const cbt = createCbtModule({ audit, auth, scope: users.scope, notifier: communication.notifier, settings: settings.service, store, jobs: examJobs });
  router.use(cbt.router);

  router.use(
    createPortalModule({
      audit, auth, store, rateLimitRedis, scope: users.scope, armIdsOfUser: users.armIdsOfUser, teacherArms: academics.teacherArms,
      notifier: communication.notifier, announcements: communication.announcements, taskService: tasks.service,
      attempts: cbt.attempts, examService: cbt.exams, resultsCtx: results.ctx, settings: settings.service, reportJobs,
      finance: fees.financeWidgets, financeReports: fees.financeReports,
    }).router,
  );

  // A route without authorize() or publicRoute() stops the app from starting.
  assertAllRoutesGuarded(router);
  return { router, paystackWebhook: fees.webhook };
}