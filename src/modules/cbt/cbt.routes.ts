import { Router, type RequestHandler } from 'express';
import multer from 'multer';
import { AppError } from '../../common/errors/AppError';
import { authorize } from '../../common/middleware/authorize';
import { validate, type Validated } from '../../common/middleware/validate';
import { buildPageMeta, sendCreated, sendSuccess } from '../../common/utils/apiResponse';
import { contextOf, requireUser } from '../../common/utils/request';
import { ROLES } from '../../config/constants';
import type { AnalyticsService } from './analytics.service';
import type { AttemptService } from './attempt.service';
import {
  attemptsListSchemas, confirmQuestionsSchemas, createExamSchemas, examIdSchemas, listExamsSchemas, rejectSchemas,
  saveAnswersSchemas, scheduleSchemas, submitAttemptSchemas, updateExamSchemas,
} from './cbt.schema';
import type { ExamService } from './exam.service';
import { QUESTION_TEMPLATE_CSV, type QuestionImportService } from './question.import';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 0 } });
const CSV_TYPES = new Set(['text/csv', 'application/csv', 'application/vnd.ms-excel', 'text/plain']);

export function createCbtRouter(deps: {
  exams: ExamService; attempts: AttemptService; analytics: AnalyticsService; importService: QuestionImportService; authenticate: RequestHandler;
}): Router {
  const { exams, attempts, analytics, importService, authenticate: auth } = deps;
  const router = Router();

  // Parents and students have their own routes. The staff routes refuse them.
  const staffOnly = (role: string): void => {
    if (role === ROLES.PARENT || role === ROLES.STUDENT) throw new AppError('FORBIDDEN');
  };

  router.get('/cbt/template.csv', auth, authorize('cbt:manage'), validate({}), (_req, res) => {
    res.status(200);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="cbt-questions-template.csv"');
    res.send(QUESTION_TEMPLATE_CSV);
  });

  // ---- exams (teachers, admins)
  router.post('/cbt/exams', auth, authorize('cbt:manage'), validate(createExamSchemas), async (req, res) => {
    const { body } = req.validated as Validated<typeof createExamSchemas>;
    sendCreated(res, await exams.create(requireUser(req), body, contextOf(req)));
  });

  router.get('/cbt/exams', auth, authorize('cbt:read'), validate(listExamsSchemas), async (req, res) => {
    const user = requireUser(req);
    staffOnly(user.role);
    const { query } = req.validated as Validated<typeof listExamsSchemas>;
    const { items, total } = await exams.list(user, query);
    sendSuccess(res, items, { meta: buildPageMeta({ page: query.page, limit: query.limit, total }) });
  });

  router.get('/cbt/exams/:id', auth, authorize('cbt:read'), validate(examIdSchemas), async (req, res) => {
    const user = requireUser(req);
    staffOnly(user.role);
    const { params } = req.validated as Validated<typeof examIdSchemas>;
    sendSuccess(res, await exams.get(user, params.id));
  });

  router.patch('/cbt/exams/:id', auth, authorize('cbt:manage'), validate(updateExamSchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof updateExamSchemas>;
    sendSuccess(res, await exams.update(requireUser(req), params.id, body, contextOf(req)));
  });

  router.delete('/cbt/exams/:id', auth, authorize('cbt:read'), validate(examIdSchemas), async (req, res) => {
    const user = requireUser(req);
    if (user.role !== ROLES.TEACHER && user.role !== ROLES.ADMIN) throw new AppError('FORBIDDEN');
    const { params } = req.validated as Validated<typeof examIdSchemas>;
    await exams.remove(user, params.id, contextOf(req));
    sendSuccess(res, null);
  });

  router.get('/cbt/exams/:id/questions', auth, authorize('cbt:analytics'), validate(examIdSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof examIdSchemas>;
    sendSuccess(res, await exams.questionsFor(requireUser(req), params.id));
  });

  router.post('/cbt/exams/:id/questions/import', auth, authorize('cbt:manage'), upload.single('file'), validate(examIdSchemas), async (req, res) => {
    const file = req.file;
    if (!file || !/\.csv$/i.test(file.originalname) || !CSV_TYPES.has(file.mimetype)) {
      throw new AppError('VALIDATION_ERROR', { details: [{ field: 'file', issue: 'Attach a .csv file in the "file" field' }] });
    }
    const { params } = req.validated as Validated<typeof examIdSchemas>;
    sendSuccess(res, await importService.upload(requireUser(req), params.id, file.originalname, file.buffer));
  });

  router.post('/cbt/exams/:id/questions/import/confirm', auth, authorize('cbt:manage'), validate(confirmQuestionsSchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof confirmQuestionsSchemas>;
    sendSuccess(res, await importService.confirm(requireUser(req), params.id, body.importToken, contextOf(req)));
  });

  router.post('/cbt/exams/:id/submit-for-approval', auth, authorize('cbt:manage'), validate(examIdSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof examIdSchemas>;
    sendSuccess(res, await exams.submitForApproval(requireUser(req), params.id, contextOf(req)));
  });

  router.post('/cbt/exams/:id/approve', auth, authorize('cbt:approve'), validate(examIdSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof examIdSchemas>;
    sendSuccess(res, await exams.approve(requireUser(req), params.id, contextOf(req)));
  });

  router.post('/cbt/exams/:id/reject', auth, authorize('cbt:approve'), validate(rejectSchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof rejectSchemas>;
    sendSuccess(res, await exams.reject(requireUser(req), params.id, body, contextOf(req)));
  });

  router.post('/cbt/exams/:id/release-results', auth, authorize('cbt:manage'), validate(examIdSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof examIdSchemas>;
    sendSuccess(res, await exams.releaseResults(requireUser(req), params.id, contextOf(req)));
  });

  router.get('/cbt/exams/:id/analytics', auth, authorize('cbt:analytics'), validate(examIdSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof examIdSchemas>;
    sendSuccess(res, await analytics.analytics(requireUser(req), params.id));
  });

  router.get('/cbt/exams/:id/attempts', auth, authorize('cbt:analytics'), validate(attemptsListSchemas), async (req, res) => {
    const { params, query } = req.validated as Validated<typeof attemptsListSchemas>;
    const { items, total } = await analytics.attemptsOf(requireUser(req), params.id, query);
    sendSuccess(res, items, { meta: buildPageMeta({ page: query.page, limit: query.limit, total }) });
  });

  // ---- schedule (parents, students)
  router.get('/cbt/schedule', auth, authorize('cbt:read'), validate(scheduleSchemas), async (req, res) => {
    const user = requireUser(req);
    if (user.role !== ROLES.PARENT && user.role !== ROLES.STUDENT) throw new AppError('FORBIDDEN');
    const { query } = req.validated as Validated<typeof scheduleSchemas>;
    sendSuccess(res, await attempts.schedule(user, query.studentId));
  });

  // ---- taking an exam (students)
  router.get('/cbt/time', auth, authorize('cbt:take'), validate({}), (_req, res) => {
    sendSuccess(res, attempts.time());
  });

  router.get('/cbt/my-exams', auth, authorize('cbt:take'), validate({}), async (req, res) => {
    sendSuccess(res, await attempts.myExams(requireUser(req)));
  });

  router.post('/cbt/exams/:id/start', auth, authorize('cbt:take'), validate(examIdSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof examIdSchemas>;
    sendSuccess(res, await attempts.start(requireUser(req), params.id));
  });

  router.get('/cbt/attempts/:id', auth, authorize('cbt:take'), validate(examIdSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof examIdSchemas>;
    sendSuccess(res, await attempts.resume(requireUser(req), params.id));
  });

  router.put('/cbt/attempts/:id/answers', auth, authorize('cbt:take'), validate(saveAnswersSchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof saveAnswersSchemas>;
    sendSuccess(res, await attempts.saveAnswers(requireUser(req), params.id, body.answers));
  });

  router.post('/cbt/attempts/:id/submit', auth, authorize('cbt:take'), validate(submitAttemptSchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof submitAttemptSchemas>;
    sendSuccess(res, await attempts.submit(requireUser(req), params.id, body.answers));
  });

  router.get('/cbt/attempts/:id/result', auth, authorize('cbt:take'), validate(examIdSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof examIdSchemas>;
    sendSuccess(res, await attempts.result(requireUser(req), params.id));
  });

  return router;
}