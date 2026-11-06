import { Router, type RequestHandler } from 'express';
import multer from 'multer';
import { AppError } from '../../common/errors/AppError';
import { authorize } from '../../common/middleware/authorize';
import { validate, type Validated } from '../../common/middleware/validate';
import type { ScopeService } from '../../common/scope/scope.service';
import { buildPageMeta, sendCreated, sendSuccess } from '../../common/utils/apiResponse';
import { detectImageType } from '../../common/utils/image';
import { contextOf, requireUser } from '../../common/utils/request';
import { ROLES } from '../../config/constants';
import type { StudentImportService } from './student.import';
import {
  confirmImportSchemas, createStudentSchemas, enrolStudentSchemas, listStudentsSchemas, studentIdSchemas, updateStudentSchemas,
} from './student.schema';
import type { StudentService } from './student.service';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 0 } });
const uploadImage = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 0 } });
const CSV_TYPES = new Set(['text/csv', 'application/csv', 'application/vnd.ms-excel', 'text/plain']);

export function createStudentRouter(deps: {
  service: StudentService;
  importService: StudentImportService;
  authenticate: RequestHandler;
  scope: ScopeService;
}): Router {
  const { service, importService, authenticate: auth, scope } = deps;
  const router = Router();

  router.get('/students', auth, authorize('students:read'), validate(listStudentsSchemas), async (req, res) => {
    const user = requireUser(req);
    if (user.role === ROLES.PARENT || user.role === ROLES.STUDENT) throw new AppError('FORBIDDEN');
    const { query } = req.validated as Validated<typeof listStudentsSchemas>;
    const { items, total } = await service.list(user, query);
    sendSuccess(res, items, { meta: buildPageMeta({ page: query.page, limit: query.limit, total }) });
  });

  router.post('/students', auth, authorize('students:write'), validate(createStudentSchemas), async (req, res) => {
    const { body } = req.validated as Validated<typeof createStudentSchemas>;
    sendCreated(res, await service.create(body, requireUser(req), contextOf(req)));
  });

  router.post(
    '/students/import', auth, authorize('students:import'), upload.single('file'), validate({}),
    async (req, res) => {
      const file = req.file;
      const looksLikeCsv = file && /\.csv$/i.test(file.originalname) && CSV_TYPES.has(file.mimetype);
      if (!file || !looksLikeCsv) {
        throw new AppError('VALIDATION_ERROR', { details: [{ field: 'file', issue: 'Attach a .csv file in the "file" field' }] });
      }
      sendSuccess(res, await importService.upload(file.buffer, requireUser(req)));
    },
  );

  router.post('/students/import/confirm', auth, authorize('students:import'), validate(confirmImportSchemas), async (req, res) => {
    const { body } = req.validated as Validated<typeof confirmImportSchemas>;
    sendSuccess(res, await importService.confirm(body.importToken, requireUser(req), contextOf(req)));
  });

  router.get('/students/:id', auth, authorize('students:read'), validate(studentIdSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof studentIdSchemas>;
    await scope.assertCanAccessStudent(requireUser(req), params.id); // out of scope is a 404
    sendSuccess(res, await service.get(params.id));
  });

  router.patch('/students/:id', auth, authorize('students:write'), validate(updateStudentSchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof updateStudentSchemas>;
    sendSuccess(res, await service.update(params.id, body, requireUser(req), contextOf(req)));
  });

  router.put(
    '/students/:id/passport', auth, authorize('students:write'), uploadImage.single('file'), validate(studentIdSchemas),
    async (req, res) => {
      const { params } = req.validated as Validated<typeof studentIdSchemas>;
      const file = req.file;
      if (!file || !detectImageType(file.buffer)) {
        throw new AppError('VALIDATION_ERROR', { details: [{ field: 'file', issue: 'Attach a JPEG, PNG or WebP image in the "file" field' }] });
      }
      sendSuccess(res, await service.setPassport(params.id, file.buffer, requireUser(req), contextOf(req)));
    },
  );

  router.delete('/students/:id/passport', auth, authorize('students:write'), validate(studentIdSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof studentIdSchemas>;
    sendSuccess(res, await service.removePassport(params.id, requireUser(req), contextOf(req)));
  });

  router.delete('/students/:id', auth, authorize('students:write'), validate(studentIdSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof studentIdSchemas>;
    await service.remove(params.id, requireUser(req), contextOf(req));
    sendSuccess(res, null);
  });

  router.put('/students/:id/enrolment', auth, authorize('students:write'), validate(enrolStudentSchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof enrolStudentSchemas>;
    sendSuccess(res, await service.enrol(params.id, body, requireUser(req), contextOf(req)));
  });

  return router;
}