import { Router, type RequestHandler } from 'express';
import { authorize } from '../../common/middleware/authorize';
import { validate, type Validated } from '../../common/middleware/validate';
import { sendSuccess } from '../../common/utils/apiResponse';
import { requireUser } from '../../common/utils/request';
import type { DashboardService } from './dashboard.service';
import { rosterSchemas } from './dashboard.schema';
import type { TeacherPortalService } from './teacher.service';

export function createDashboardRouter(deps: { service: DashboardService; teacher: TeacherPortalService; authenticate: RequestHandler }): Router {
  const { service, teacher, authenticate: auth } = deps;
  const router = Router();

  router.get('/super-admin/dashboard', auth, authorize('dashboard:super-admin'), validate({}), async (req, res) => {
    sendSuccess(res, await service.superAdmin(requireUser(req)));
  });
  router.get('/admin/dashboard', auth, authorize('dashboard:admin'), validate({}), async (req, res) => {
    sendSuccess(res, await service.admin(requireUser(req)));
  });
  router.get('/teacher/dashboard', auth, authorize('dashboard:teacher'), validate({}), async (req, res) => {
    sendSuccess(res, await service.teacher(requireUser(req)));
  });
  router.get('/student/dashboard', auth, authorize('dashboard:student'), validate({}), async (req, res) => {
    sendSuccess(res, await service.student(requireUser(req)));
  });
  router.get('/parent/dashboard', auth, authorize('dashboard:parent'), validate({}), async (req, res) => {
    sendSuccess(res, await service.parent(requireUser(req)));
  });

  router.get('/teacher/me/classes', auth, authorize('teacher-classes:read'), validate({}), async (req, res) => {
    sendSuccess(res, await teacher.classes(requireUser(req)));
  });
  router.get('/teacher/me/classes/:classArmId/roster', auth, authorize('teacher-classes:read'), validate(rosterSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof rosterSchemas>;
    sendSuccess(res, await teacher.roster(requireUser(req), params.classArmId));
  });

  return router;
}