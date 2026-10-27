import { Router } from 'express';
import { createHealthRouter, type HealthDependencies } from './modules/health/health.routes';

export function createRoutes(deps: HealthDependencies): Router {
  const router = Router();

  router.use(createHealthRouter(deps));

  // Each phase mounts its modules here, for example:
  // router.use('/auth', authRouter);

  return router;
}