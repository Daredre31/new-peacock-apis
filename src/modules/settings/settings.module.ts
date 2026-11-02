import { Router } from 'express';
import { authorize } from '../../common/middleware/authorize';
import { validate, type Validated } from '../../common/middleware/validate';
import { sendSuccess } from '../../common/utils/apiResponse';
import { contextOf, requireUser } from '../../common/utils/request';
import type { AuditService } from '../audit/audit.service';
import type { AuthModule } from '../auth/auth.module';
import { settingsRepository } from './settings.repository';
import { setGradingScaleSchemas } from './settings.schema';
import { createSettingsService } from './settings.service';

export function createSettingsModule(deps: { audit: AuditService; auth: AuthModule; assessmentInUse?: () => Promise<boolean> }) {
  const auth = deps.auth.middleware.authenticate;
  const service = createSettingsService({ repo: settingsRepository, audit: deps.audit, assessmentInUse: deps.assessmentInUse });

  const router = Router();
  router.get('/settings/grading-scale', auth, authorize('grading-scale:read'), validate({}), async (_req, res) => {
    sendSuccess(res, await service.getAssessment());
  });
  router.put('/settings/grading-scale', auth, authorize('grading-scale:write'), validate(setGradingScaleSchemas), async (req, res) => {
    const { body } = req.validated as Validated<typeof setGradingScaleSchemas>;
    sendSuccess(res, await service.setAssessment(body, requireUser(req), contextOf(req)));
  });

  return { router, service };
}