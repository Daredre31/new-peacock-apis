import { Router, type RequestHandler } from 'express';
import { authorize } from '../../common/middleware/authorize';
import { validate, type Validated } from '../../common/middleware/validate';
import { sendSuccess } from '../../common/utils/apiResponse';
import { contextOf, requireUser } from '../../common/utils/request';
import { replaceTimetableSchemas, timetableSchemas } from './timetable.schema';
import type { TimetableService } from './timetable.service';

export function createTimetableRouter(deps: { service: TimetableService; authenticate: RequestHandler }): Router {
  const { service, authenticate: auth } = deps;
  const router = Router();

  router.get('/timetable/:classArmId', auth, authorize('academics:read'), validate(timetableSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof timetableSchemas>;
    sendSuccess(res, await service.get(requireUser(req), params.classArmId));
  });

  router.put('/timetable/:classArmId', auth, authorize('academics:write'), validate(replaceTimetableSchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof replaceTimetableSchemas>;
    sendSuccess(res, await service.replace(requireUser(req), params.classArmId, body, contextOf(req)));
  });

  router.get('/teacher/me/timetable', auth, authorize('teacher-classes:read'), validate({}), async (req, res) => {
    sendSuccess(res, await service.forTeacher(requireUser(req)));
  });

  return router;
}