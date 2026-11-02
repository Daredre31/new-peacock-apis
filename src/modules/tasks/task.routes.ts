import { Router, type RequestHandler } from 'express';
import { AppError } from '../../common/errors/AppError';
import { authorize } from '../../common/middleware/authorize';
import { validate, type Validated } from '../../common/middleware/validate';
import type { ScopeService } from '../../common/scope/scope.service';
import { buildPageMeta, sendCreated, sendSuccess } from '../../common/utils/apiResponse';
import { contextOf, requireUser } from '../../common/utils/request';
import { ROLES } from '../../config/constants';
import {
  childTasksSchemas, createTaskSchemas, gradeSchemas, listTasksSchemas, myTasksSchemas, submitSchemas, taskIdSchemas, updateTaskSchemas,
} from './task.schema';
import type { TaskService } from './task.service';

export function createTaskRouter(deps: { service: TaskService; authenticate: RequestHandler; scope: ScopeService }): Router {
  const { service: s, authenticate: auth } = deps;
  const router = Router();

  // Parents and students use their own routes. These are for teachers and admins.
  const staffOnly = (role: string): void => {
    if (role !== ROLES.TEACHER && role !== ROLES.ADMIN) throw new AppError('FORBIDDEN');
  };

  router.get('/tasks', auth, authorize('tasks:read'), validate(listTasksSchemas), async (req, res) => {
    const user = requireUser(req);
    staffOnly(user.role);
    const { query } = req.validated as Validated<typeof listTasksSchemas>;
    const { items, total } = await s.list(user, query);
    sendSuccess(res, items, { meta: buildPageMeta({ page: query.page, limit: query.limit, total }) });
  });

  router.post('/tasks', auth, authorize('tasks:write'), validate(createTaskSchemas), async (req, res) => {
    const { body } = req.validated as Validated<typeof createTaskSchemas>;
    sendCreated(res, await s.create(requireUser(req), body, contextOf(req)));
  });

  router.get('/tasks/:id', auth, authorize('tasks:read'), validate(taskIdSchemas), async (req, res) => {
    const user = requireUser(req);
    staffOnly(user.role);
    const { params } = req.validated as Validated<typeof taskIdSchemas>;
    sendSuccess(res, await s.get(user, params.id));
  });

  router.patch('/tasks/:id', auth, authorize('tasks:write'), validate(updateTaskSchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof updateTaskSchemas>;
    sendSuccess(res, await s.update(requireUser(req), params.id, body, contextOf(req)));
  });

  router.delete('/tasks/:id', auth, authorize('tasks:write'), validate(taskIdSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof taskIdSchemas>;
    await s.remove(requireUser(req), params.id, contextOf(req));
    sendSuccess(res, null);
  });

  router.get('/tasks/:id/submissions', auth, authorize('tasks:write'), validate(taskIdSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof taskIdSchemas>;
    sendSuccess(res, await s.submissions(requireUser(req), params.id));
  });

  router.patch('/submissions/:id/grade', auth, authorize('tasks:write'), validate(gradeSchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof gradeSchemas>;
    sendSuccess(res, await s.grade(requireUser(req), params.id, body, contextOf(req)));
  });

  router.get('/student/me/tasks', auth, authorize('tasks:own'), validate(myTasksSchemas), async (req, res) => {
    const { query } = req.validated as Validated<typeof myTasksSchemas>;
    const { items, total } = await s.myTasks(requireUser(req), query);
    sendSuccess(res, items, { meta: buildPageMeta({ page: query.page, limit: query.limit, total }) });
  });

  router.get('/student/me/tasks/analytics', auth, authorize('tasks:own'), validate({}), async (req, res) => {
    sendSuccess(res, await s.analytics(requireUser(req)));
  });

  router.post('/tasks/:id/submit', auth, authorize('tasks:submit'), validate(submitSchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof submitSchemas>;
    sendCreated(res, await s.submit(requireUser(req), params.id, body));
  });

  router.get('/children/:id/tasks', auth, authorize('children:read'), validate(childTasksSchemas), async (req, res) => {
    const { params, query } = req.validated as Validated<typeof childTasksSchemas>;
    const { items, total } = await s.childTasks(requireUser(req), params.id, query);
    sendSuccess(res, items, { meta: buildPageMeta({ page: query.page, limit: query.limit, total }) });
  });

  return router;
}