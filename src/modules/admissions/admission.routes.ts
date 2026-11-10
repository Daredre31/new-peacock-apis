import { Router, type RequestHandler } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import multer from 'multer';
import { AppError } from '../../common/errors/AppError';
import { authorize, publicRoute } from '../../common/middleware/authorize';
import { createRateLimiter, type RedisLike } from '../../common/middleware/rateLimiter';
import { validate, type Validated } from '../../common/middleware/validate';
import { buildPageMeta, sendCreated, sendSuccess } from '../../common/utils/apiResponse';
import { contextOf, requireUser } from '../../common/utils/request';
import type { AdmissionService } from './admission.service';
import {
  acceptSchemas, applicationIdSchemas, applySchemas, declineSchemas, identifySchemas, listApplicationsSchemas, photoSchemas, updateSettingsSchemas,
} from './admission.schema';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 4 } });
const ipKey = (req: { ip?: string | undefined }): string => ipKeyGenerator(req.ip ?? 'unknown');

export function createAdmissionRouter(deps: { service: AdmissionService; authenticate: RequestHandler; redis: RedisLike | null }): Router {
  const { service, authenticate: auth, redis } = deps;
  const router = Router();
  const none = validate({});

  // Anyone on the internet can reach these, so each one has its own limit.
  const applyLimiter = createRateLimiter({ name: 'admission-apply', windowMs: 60 * 60_000, limit: 10, key: ipKey, redis, onRedisFailure: 'use-memory' });
  const lookupLimiter = createRateLimiter({ name: 'admission-lookup', windowMs: 15 * 60_000, limit: 40, key: ipKey, redis, onRedisFailure: 'use-memory' });
  const photoLimiter = createRateLimiter({ name: 'admission-photo', windowMs: 60 * 60_000, limit: 20, key: ipKey, redis, onRedisFailure: 'use-memory' });

  // ---- public
  router.get('/public/admissions/info', publicRoute(), lookupLimiter, none, async (_req, res) => { sendSuccess(res, await service.info()); });
  router.post('/public/admissions', publicRoute(), applyLimiter, validate(applySchemas), async (req, res) => {
    const { body } = req.validated as Validated<typeof applySchemas>;
    sendCreated(res, await service.apply(body, contextOf(req)));
  });
  router.post('/public/admissions/pay', publicRoute(), lookupLimiter, validate(identifySchemas), async (req, res) => {
    const { body } = req.validated as Validated<typeof identifySchemas>;
    sendSuccess(res, await service.pay(body));
  });
  router.post('/public/admissions/status', publicRoute(), lookupLimiter, validate(identifySchemas), async (req, res) => {
    const { body } = req.validated as Validated<typeof identifySchemas>;
    sendSuccess(res, await service.status(body));
  });
  router.post('/public/admissions/photo', publicRoute(), photoLimiter, upload.single('file'), validate(photoSchemas), async (req, res) => {
    const { body } = req.validated as Validated<typeof photoSchemas>;
    if (!req.file) throw new AppError('VALIDATION_ERROR', { details: [{ field: 'file', issue: 'Choose a photo to upload' }] });
    sendSuccess(res, await service.uploadPhoto({ ...body, image: req.file.buffer }));
  });

  // ---- staff. The fixed paths come before /admissions/:id.
  router.get('/admissions', auth, authorize('admissions:read'), validate(listApplicationsSchemas), async (req, res) => {
    const { query } = req.validated as Validated<typeof listApplicationsSchemas>;
    const { items, total } = await service.list(query);
    sendSuccess(res, items, { meta: buildPageMeta({ page: query.page, limit: query.limit, total }) });
  });
  router.get('/admissions/settings', auth, authorize('admissions:read'), none, async (_req, res) => { sendSuccess(res, await service.getSettings()); });
  router.put('/admissions/settings', auth, authorize('admissions:settings'), validate(updateSettingsSchemas), async (req, res) => {
    const { body } = req.validated as Validated<typeof updateSettingsSchemas>;
    sendSuccess(res, await service.updateSettings(requireUser(req), body, contextOf(req)));
  });
  router.get('/admissions/:id', auth, authorize('admissions:read'), validate(applicationIdSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof applicationIdSchemas>;
    sendSuccess(res, await service.get(params.id));
  });
  router.post('/admissions/:id/accept', auth, authorize('admissions:review'), validate(acceptSchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof acceptSchemas>;
    sendSuccess(res, await service.accept(requireUser(req), params.id, body, contextOf(req)));
  });
  router.post('/admissions/:id/decline', auth, authorize('admissions:review'), validate(declineSchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof declineSchemas>;
    sendSuccess(res, await service.decline(requireUser(req), params.id, body.reason, contextOf(req)));
  });
  router.post('/admissions/:id/recheck-payment', auth, authorize('admissions:review'), validate(applicationIdSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof applicationIdSchemas>;
    sendSuccess(res, await service.recheckPayment(requireUser(req), params.id, contextOf(req)));
  });

  return router;
}
