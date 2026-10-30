import { Router } from 'express';
import { AppError } from '../../common/errors/AppError';
import type { DependencyHealth } from '../../common/types/health';
import { sendSuccess } from '../../common/utils/apiResponse';
import { publicRoute } from '../../common/middleware/authorize';

export interface HealthDependencies {
  checkMongo: () => Promise<DependencyHealth>;
  checkRedis: () => Promise<DependencyHealth>;
}

async function isHealthy(check: () => Promise<DependencyHealth>): Promise<boolean> {
  try {
    return (await check()).ok;
  } catch {
    return false;
  }
}

export function createHealthRouter(deps: HealthDependencies): Router {
  const router = Router();

  // Liveness: the process is up and the event loop answers. Touches no dependency.
  router.get('/health',publicRoute(), (_req, res) => {
    sendSuccess(res, { status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
  });

  // Readiness: MongoDB and Redis both answer. The public response never says which one failed.
  router.get('/ready',publicRoute() ,async (req, res) => {
    const [mongo, redis] = await Promise.all([
      isHealthy(deps.checkMongo),
      isHealthy(deps.checkRedis),
    ]);

    if (!mongo || !redis) {
      req.log.warn({ mongo, redis }, 'readiness check failed');
      throw new AppError('SERVICE_UNAVAILABLE');
    }

    sendSuccess(res, { status: 'ready' });
  });

  return router;
}