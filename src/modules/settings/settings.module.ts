import { Router } from 'express';
import multer from 'multer';
import { AppError } from '../../common/errors/AppError';
import { authorize } from '../../common/middleware/authorize';
import { validate, type Validated } from '../../common/middleware/validate';
import { sendSuccess } from '../../common/utils/apiResponse';
import { detectImageType } from '../../common/utils/image';
import { contextOf, requireUser } from '../../common/utils/request';
import type { AuditService } from '../audit/audit.service';
import type { AuthModule } from '../auth/auth.module';
import { settingsRepository } from './settings.repository';
import type { ImageStore } from '../../integrations/imageStore';
import { brandingAssetSchemas, setGradingScaleSchemas, updateBrandingSchemas, updateSettingsSchemas } from './settings.schema';
import { createSettingsService } from './settings.service';

const uploadImage = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 0 } });

export function createSettingsModule(deps: { audit: AuditService; auth: AuthModule; images?: ImageStore; assessmentInUse?: () => Promise<boolean>; onStudentPasswordChangeOff?: () => Promise<number> }) {
  const auth = deps.auth.middleware.authenticate;
  const service = createSettingsService({ repo: settingsRepository, audit: deps.audit, assessmentInUse: deps.assessmentInUse, onStudentPasswordChangeOff: deps.onStudentPasswordChangeOff, images: deps.images });

  const router = Router();
  router.get('/settings/grading-scale', auth, authorize('grading-scale:read'), validate({}), async (_req, res) => {
    sendSuccess(res, await service.getAssessment());
  });
  router.put('/settings/grading-scale', auth, authorize('grading-scale:write'), validate(setGradingScaleSchemas), async (req, res) => {
    const { body } = req.validated as Validated<typeof setGradingScaleSchemas>;
    sendSuccess(res, await service.setAssessment(body, requireUser(req), contextOf(req)));
  });
  router.get('/settings', auth, authorize('session:self'), validate({}), async (req, res) => {
    sendSuccess(res, await service.view(requireUser(req).role));
  });
  router.put('/settings', auth, authorize('settings:write'), validate(updateSettingsSchemas), async (req, res) => {
    const { body } = req.validated as Validated<typeof updateSettingsSchemas>;
    sendSuccess(res, await service.update(body, requireUser(req), contextOf(req)));
  });

  router.get('/settings/branding', auth, authorize('session:self'), validate({}), async (_req, res) => {
    sendSuccess(res, await service.getBranding());
  });
  router.put('/settings/branding', auth, authorize('branding:write'), validate(updateBrandingSchemas), async (req, res) => {
    const { body } = req.validated as Validated<typeof updateBrandingSchemas>;
    sendSuccess(res, await service.updateBranding(body, requireUser(req), contextOf(req)));
  });
  router.put('/settings/branding/:asset', auth, authorize('branding:write'), uploadImage.single('file'), validate(brandingAssetSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof brandingAssetSchemas>;
    const file = req.file;
    if (!file || !detectImageType(file.buffer)) {
      throw new AppError('VALIDATION_ERROR', { details: [{ field: 'file', issue: 'Attach a JPEG, PNG or WebP image in the "file" field' }] });
    }
    sendSuccess(res, await service.setBrandingImage(params.asset, file.buffer, requireUser(req), contextOf(req)));
  });
  router.delete('/settings/branding/:asset', auth, authorize('branding:write'), validate(brandingAssetSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof brandingAssetSchemas>;
    sendSuccess(res, await service.removeBrandingImage(params.asset, requireUser(req), contextOf(req)));
  });

  return { router, service };
}