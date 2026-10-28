import { Router } from 'express';
import type { AuthModule } from './modules/auth/auth.module';
import { createHealthRouter, type HealthDependencies } from './modules/health/health.routes';

export interface RouteDeps {
  health: HealthDependencies;
  auth: AuthModule;
}

export function createRoutes({ health, auth }: RouteDeps): Router {
  const router = Router();

  router.use(createHealthRouter(health));
  router.use('/auth', auth.router);

  // Each phase mounts its modules here.

  return router;
}