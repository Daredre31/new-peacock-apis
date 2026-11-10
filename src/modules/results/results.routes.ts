import { Router, type RequestHandler } from 'express';
import multer from 'multer';
import { AppError } from '../../common/errors/AppError';
import { authorize } from '../../common/middleware/authorize';
import { validate, type Validated } from '../../common/middleware/validate';
import { sendSuccess } from '../../common/utils/apiResponse';
import { contextOf, requireUser } from '../../common/utils/request';
import type { AnnualResultsService } from './annualResults.service';
import type { ReportCardsService } from './reportCards.service';
import {
  annualSchemas, armTermSchemas, confirmImportSchemas, gridSchemas, importQuerySchemas, moderateSchemas, reportCardPdfSchemas,
  saveGridSchemas, saveReportCardsSchemas, studentResultsSchemas, submitSchemas, unlockSchemas,
} from './results.schema';
import type { ResultsService } from './results.service';
import type { ScoresImportService } from './scores.import';
import type { ScoresService } from './scores.service';
import type { StudentResultsService } from './studentResults.service';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 0 } });
const CSV_TYPES = new Set(['text/csv', 'application/csv', 'application/vnd.ms-excel', 'text/plain']);

export function createResultsRouter(deps: {
  scoresService: ScoresService; importService: ScoresImportService; resultsService: ResultsService;
  reportCardsService: ReportCardsService; studentResults: StudentResultsService; annual: AnnualResultsService; authenticate: RequestHandler;
}): Router {
  const { scoresService, importService, resultsService, reportCardsService, studentResults, annual, authenticate: auth } = deps;
  const router = Router();

  // ---- scores (the subject teacher)
  router.get('/scores/grid', auth, authorize('scores:enter'), validate(gridSchemas), async (req, res) => {
    const { query } = req.validated as Validated<typeof gridSchemas>;
    sendSuccess(res, await scoresService.grid(requireUser(req), query));
  });
  router.put('/scores/grid', auth, authorize('scores:enter'), validate(saveGridSchemas), async (req, res) => {
    const { body } = req.validated as Validated<typeof saveGridSchemas>;
    sendSuccess(res, await scoresService.saveGrid(requireUser(req), body, contextOf(req)));
  });
  router.post('/scores/submit', auth, authorize('scores:enter'), validate(submitSchemas), async (req, res) => {
    const { body } = req.validated as Validated<typeof submitSchemas>;
    sendSuccess(res, await scoresService.submit(requireUser(req), body, contextOf(req)));
  });
  router.post('/scores/import', auth, authorize('scores:enter'), upload.single('file'), validate(importQuerySchemas), async (req, res) => {
    const file = req.file;
    if (!file || !/\.csv$/i.test(file.originalname) || !CSV_TYPES.has(file.mimetype)) {
      throw new AppError('VALIDATION_ERROR', { details: [{ field: 'file', issue: 'Attach a .csv file in the "file" field' }] });
    }
    const { query } = req.validated as Validated<typeof importQuerySchemas>;
    sendSuccess(res, await importService.upload(requireUser(req), query, file.buffer));
  });
  router.post('/scores/import/confirm', auth, authorize('scores:enter'), validate(confirmImportSchemas), async (req, res) => {
    const { body } = req.validated as Validated<typeof confirmImportSchemas>;
    sendSuccess(res, await importService.confirm(requireUser(req), body.importToken, contextOf(req)));
  });

  // ---- report cards (the class teacher)
  router.get('/report-cards/:classArmId/:termId', auth, authorize('report-cards:compile'), validate(armTermSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof armTermSchemas>;
    sendSuccess(res, await reportCardsService.compile(requireUser(req), params.classArmId, params.termId));
  });
  router.put('/report-cards/:classArmId/:termId', auth, authorize('report-cards:compile'), validate(saveReportCardsSchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof saveReportCardsSchemas>;
    sendSuccess(res, await reportCardsService.save(requireUser(req), params.classArmId, params.termId, body.entries, contextOf(req)));
  });

  // ---- results (admin and super admin)
  router.get('/results/annual/:classArmId/:sessionId', auth, authorize('results:annual'), validate(annualSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof annualSchemas>;
    sendSuccess(res, await annual.forArm(params.classArmId, params.sessionId));
  });
  router.get('/results/:classArmId/:termId', auth, authorize('results:sheet'), validate(armTermSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof armTermSchemas>;
    sendSuccess(res, await resultsService.sheet(params.classArmId, params.termId));
  });
  router.post('/results/:classArmId/:termId/moderate', auth, authorize('results:moderate'), validate(moderateSchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof moderateSchemas>;
    sendSuccess(res, await resultsService.moderate(requireUser(req), params.classArmId, params.termId, body, contextOf(req)));
  });
  router.post('/results/:classArmId/:termId/publish', auth, authorize('results:publish'), validate(armTermSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof armTermSchemas>;
    sendSuccess(res, await resultsService.publish(requireUser(req), params.classArmId, params.termId, contextOf(req)));
  });
  router.post('/results/:classArmId/:termId/lock', auth, authorize('results:lock'), validate(armTermSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof armTermSchemas>;
    sendSuccess(res, await resultsService.lock(requireUser(req), params.classArmId, params.termId, contextOf(req)));
  });
  router.post('/results/:classArmId/:termId/unlock', auth, authorize('results:lock'), validate(unlockSchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof unlockSchemas>;
    sendSuccess(res, await resultsService.unlock(requireUser(req), params.classArmId, params.termId, body, contextOf(req)));
  });

  // ---- a student's results and report card
  router.get('/students/:id/results', auth, authorize('results:read'), validate(studentResultsSchemas), async (req, res) => {
    const { params, query } = req.validated as Validated<typeof studentResultsSchemas>;
    sendSuccess(res, await studentResults.results(requireUser(req), params.id, query.termId));
  });
  router.get('/students/:id/report-card.pdf', auth, authorize('report-cards:read'), validate(reportCardPdfSchemas), async (req, res) => {
    const { params, query } = req.validated as Validated<typeof reportCardPdfSchemas>;
    const { filename, buffer } = await studentResults.reportCardPdf(requireUser(req), params.id, query.termId);
    res.status(200);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.end(buffer);
  });

  return router;
}