import { Router, type RequestHandler } from 'express';
import { authorize } from '../../common/middleware/authorize';
import { validate, type Validated } from '../../common/middleware/validate';
import { buildPageMeta, sendCreated, sendSuccess } from '../../common/utils/apiResponse';
import { contextOf, requireUser } from '../../common/utils/request';
import { ROLES } from '../../config/constants';
import {
  assignmentIdSchemas, classTeacherSchemas, createAssignmentSchemas, listAssignmentsSchemas, reassignSchemas,
} from './assignment.schema';
import type { AssignmentService } from './assignment.service';

export function createAssignmentRouter(deps: { service: AssignmentService; authenticate: RequestHandler }): Router {
  const { service, authenticate: auth } = deps;
  const router = Router();

  router.get('/teaching-assignments', auth, authorize('teaching-assignments:read'), validate(listAssignmentsSchemas), async (req, res) => {
    const user = requireUser(req);
    const { query } = req.validated as Validated<typeof listAssignmentsSchemas>;
    // A teacher can only ever list their own assignments, whatever they ask for.
    const filter = user.role === ROLES.TEACHER ? { ...query, teacherId: user.id } : query;
    const { items, total } = await service.list(filter);
    sendSuccess(res, items, { meta: buildPageMeta({ page: query.page, limit: query.limit, total }) });
  });

  router.post('/teaching-assignments', auth, authorize('teaching-assignments:write'), validate(createAssignmentSchemas), async (req, res) => {
    const { body } = req.validated as Validated<typeof createAssignmentSchemas>;
    sendCreated(res, await service.create(body, requireUser(req), contextOf(req)));
  });

  router.patch('/teaching-assignments/:id', auth, authorize('teaching-assignments:write'), validate(reassignSchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof reassignSchemas>;
    sendSuccess(res, await service.reassign(params.id, body.teacherId, requireUser(req), contextOf(req)));
  });

  router.delete('/teaching-assignments/:id', auth, authorize('teaching-assignments:write'), validate(assignmentIdSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof assignmentIdSchemas>;
    await service.remove(params.id, requireUser(req), contextOf(req));
    sendSuccess(res, null);
  });

  router.put('/class-arms/:id/class-teacher', auth, authorize('academics:write'), validate(classTeacherSchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof classTeacherSchemas>;
    sendSuccess(res, await service.setClassTeacher(params.id, body.teacherId, requireUser(req), contextOf(req)));
  });

  return router;
}