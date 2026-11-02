import { Router, type RequestHandler } from 'express';
import { AppError } from '../../common/errors/AppError';
import { authorize } from '../../common/middleware/authorize';
import { validate, type Validated } from '../../common/middleware/validate';
import { buildPageMeta, sendCreated, sendSuccess } from '../../common/utils/apiResponse';
import { contextOf, requireUser } from '../../common/utils/request';
import { ROLES } from '../../config/constants';
import {
  createNoticeSchemas, listAttendanceSchemas, listNoticesSchemas, listStaffAttendanceSchemas,
  markClassSchemas, markStaffSchemas, studentAttendanceSchemas,
} from './attendance.schema';
import type { AttendanceService } from './attendance.service';

export function createAttendanceRouter(deps: { service: AttendanceService; authenticate: RequestHandler }): Router {
  const { service: s, authenticate: auth } = deps;
  const router = Router();

  router.put('/attendance/class-arms/:id', auth, authorize('attendance:mark'), validate(markClassSchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof markClassSchemas>;
    sendSuccess(res, await s.markClassDay(requireUser(req), params.id, body, contextOf(req)));
  });

  router.get('/attendance', auth, authorize('attendance:read'), validate(listAttendanceSchemas), async (req, res) => {
    const user = requireUser(req);
    if (user.role === ROLES.PARENT || user.role === ROLES.STUDENT) throw new AppError('FORBIDDEN');
    const { query } = req.validated as Validated<typeof listAttendanceSchemas>;
    const { items, total } = await s.list(user, query);
    sendSuccess(res, items, { meta: buildPageMeta({ page: query.page, limit: query.limit, total }) });
  });

  router.get('/students/:id/attendance', auth, authorize('attendance:read'), validate(studentAttendanceSchemas), async (req, res) => {
    const { params, query } = req.validated as Validated<typeof studentAttendanceSchemas>;
    const { data, total } = await s.forStudent(requireUser(req), params.id, query);
    sendSuccess(res, data, { meta: buildPageMeta({ page: query.page, limit: query.limit, total }) });
  });

  router.post('/absence-notices', auth, authorize('absence-notices:create'), validate(createNoticeSchemas), async (req, res) => {
    const { body } = req.validated as Validated<typeof createNoticeSchemas>;
    sendCreated(res, await s.createNotice(requireUser(req), body, contextOf(req)));
  });

  router.get('/absence-notices', auth, authorize('absence-notices:read'), validate(listNoticesSchemas), async (req, res) => {
    const { query } = req.validated as Validated<typeof listNoticesSchemas>;
    const { items, total } = await s.listNotices(requireUser(req), query);
    sendSuccess(res, items, { meta: buildPageMeta({ page: query.page, limit: query.limit, total }) });
  });

  router.put('/staff-attendance', auth, authorize('staff-attendance:write'), validate(markStaffSchemas), async (req, res) => {
    const { body } = req.validated as Validated<typeof markStaffSchemas>;
    sendSuccess(res, await s.markStaffDay(requireUser(req), body, contextOf(req)));
  });

  router.get('/staff-attendance', auth, authorize('staff-attendance:read'), validate(listStaffAttendanceSchemas), async (req, res) => {
    const { query } = req.validated as Validated<typeof listStaffAttendanceSchemas>;
    const { items, total } = await s.listStaff(requireUser(req), query);
    sendSuccess(res, items, { meta: buildPageMeta({ page: query.page, limit: query.limit, total }) });
  });

  return router;
}