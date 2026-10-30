import { Router } from 'express';
import type { AuthModule } from './modules/auth/auth.module';
import { createHealthRouter, type HealthDependencies } from './modules/health/health.routes';
import type { AuditService } from './modules/audit/audit.service';
import { createAuditRouter } from './modules/audit/audit.routes';

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

  // Each phase mounts its modules here.

  return router;
}