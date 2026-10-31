import { Router } from 'express';
import type { AuthModule } from './modules/auth/auth.module';
import { createHealthRouter, type HealthDependencies } from './modules/health/health.routes';
import type { AuditService } from './modules/audit/audit.service';
import { createAuditRouter } from './modules/audit/audit.routes';
import { assertAllRoutesGuarded } from './common/middleware/routeGuards';
import { createSessionRouter } from './modules/academics/session.routes';
import { createSessionService } from './modules/academics/session.service';
import { createStructureRouter } from './modules/academics/structure.routes';
import { createStructureService } from './modules/academics/structure.service';
import { createUsersModule } from './modules/users/users.module';

export interface RouteDeps {
  health: HealthDependencies;
  auth: AuthModule;
  audit: AuditService;
}

export function createRoutes({ health, auth, audit }: RouteDeps): Router {
  const router = Router();

  router.use(createHealthRouter(health));
  router.use('/auth', auth.router);
   router.use('/audit-logs', createAuditRouter({ service: audit, authenticate: auth.middleware.authenticate }));
  assertAllRoutesGuarded(router);
    router.use(
    createSessionRouter({
      service: createSessionService({ audit }),
      authenticate: auth.middleware.authenticate,
    }),
  );
  router.use(
    createStructureRouter({
      service: createStructureService({ audit }),
      authenticate: auth.middleware.authenticate,
    }),
  );
    router.use(createUsersModule({ audit, auth }).router);
  // Each phase mounts its modules here.

  return router;
}