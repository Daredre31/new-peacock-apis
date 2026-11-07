import { Router, type RequestHandler } from 'express';
import multer from 'multer';
import { AppError } from '../../common/errors/AppError';
import { authorize } from '../../common/middleware/authorize';
import { validate, type Validated } from '../../common/middleware/validate';
import type { ScopeService } from '../../common/scope/scope.service';
import { buildPageMeta, sendSuccess } from '../../common/utils/apiResponse';
import { detectImageType } from '../../common/utils/image';
import { contextOf, requireUser } from '../../common/utils/request';
import { bulkApproveSchemas, decisionSchemas, listQueueSchemas, rejectSchemas, studentPhotoSchemas } from './submission.schema';
import type { PassportPhotoService } from './submission.service';
import type { SubmissionStatus } from './submission.model';

const uploadImage = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 0 } });

export function createPassportPhotoRouter(deps: { service: PassportPhotoService; authenticate: RequestHandler; scope: ScopeService }): Router {
  const { service, authenticate: auth, scope } = deps;
  const router = Router();

  router.put(
    '/students/:id/passport-photo', auth, authorize('passport-photos:submit'), uploadImage.single('file'), validate(studentPhotoSchemas),
    async (req, res) => {
      const user = requireUser(req);
      const { params } = req.validated as Validated<typeof studentPhotoSchemas>;
      await scope.assertCanAccessStudent(user, params.id); // a student only for themselves, a parent only for a linked child
      const file = req.file;
      if (!file || !detectImageType(file.buffer)) {
        throw new AppError('VALIDATION_ERROR', { details: [{ field: 'file', issue: 'Attach a JPEG, PNG or WebP image in the "file" field' }] });
      }
      sendSuccess(res, await service.submit(user, params.id, file.buffer, contextOf(req)));
    },
  );

  router.get('/students/:id/passport-photo', auth, authorize('passport-photos:read'), validate(studentPhotoSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof studentPhotoSchemas>;
    await scope.assertCanAccessStudent(requireUser(req), params.id);
    sendSuccess(res, await service.get(params.id));
  });

  router.get('/passport-photos', auth, authorize('passport-photos:review'), validate(listQueueSchemas), async (req, res) => {
    const { query } = req.validated as Validated<typeof listQueueSchemas>;
    const { items, total } = await service.list(query.status as SubmissionStatus, query.page, query.limit);
    sendSuccess(res, items, { meta: buildPageMeta({ page: query.page, limit: query.limit, total }) });
  });

  router.post('/passport-photos/approve-bulk', auth, authorize('passport-photos:review'), validate(bulkApproveSchemas), async (req, res) => {
    const { body } = req.validated as Validated<typeof bulkApproveSchemas>;
    sendSuccess(res, await service.approveMany(body.studentIds, requireUser(req), contextOf(req)));
  });

  router.post('/passport-photos/:studentId/approve', auth, authorize('passport-photos:review'), validate(decisionSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof decisionSchemas>;
    sendSuccess(res, await service.approve(params.studentId, requireUser(req), contextOf(req)));
  });

  router.post('/passport-photos/:studentId/reject', auth, authorize('passport-photos:review'), validate(rejectSchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof rejectSchemas>;
    sendSuccess(res, await service.reject(params.studentId, body.reason, requireUser(req), contextOf(req)));
  });

  return router;
}
