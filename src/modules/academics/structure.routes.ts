import { Router, type RequestHandler } from 'express';
import { authorize } from '../../common/middleware/authorize';
import { validate, type Validated } from '../../common/middleware/validate';
import { buildPageMeta, sendCreated, sendSuccess } from '../../common/utils/apiResponse';
import { contextOf, requireUser } from '../../common/utils/request';
import {
  createArmSchemas,
  createClassSchemas,
  createSubjectSchemas,
  listArmsSchemas,
  listClassesSchemas,
  listSubjectsSchemas,
  updateArmSchemas,
  updateClassSchemas,
  updateSubjectSchemas,
} from './structure.schema';
import type { StructureService } from './structure.service';

type Paged<T> = { items: T[]; total: number };

export function createStructureRouter(deps: { service: StructureService; authenticate: RequestHandler }): Router {
  const { service: s, authenticate: auth } = deps;
  const router = Router();
  const read = authorize('academics:read');
  const write = authorize('academics:write');

  const list =
    <Q extends { page: number; limit: number }>(
      fetch: (query: Q) => Promise<Paged<unknown>>,
    ): RequestHandler =>
    async (req, res) => {
      const { query } = req.validated as { query: Q };
      const { items, total } = await fetch(query);
      sendSuccess(res, items, { meta: buildPageMeta({ page: query.page, limit: query.limit, total }) });
    };

  // ---- classes
  router.get('/classes', auth, read, validate(listClassesSchemas), list((q: Validated<typeof listClassesSchemas>['query']) => s.listClasses(q)));
  router.post('/classes', auth, write, validate(createClassSchemas), async (req, res) => {
    const { body } = req.validated as Validated<typeof createClassSchemas>;
    sendCreated(res, await s.createClass(body, requireUser(req), contextOf(req)));
  });
  router.patch('/classes/:id', auth, write, validate(updateClassSchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof updateClassSchemas>;
    sendSuccess(res, await s.updateClass(params.id, body, requireUser(req), contextOf(req)));
  });

  // ---- class arms
  router.get('/class-arms', auth, read, validate(listArmsSchemas), list((q: Validated<typeof listArmsSchemas>['query']) => s.listArms(q)));
  router.post('/class-arms', auth, write, validate(createArmSchemas), async (req, res) => {
    const { body } = req.validated as Validated<typeof createArmSchemas>;
    sendCreated(res, await s.createArm(body, requireUser(req), contextOf(req)));
  });
  router.patch('/class-arms/:id', auth, write, validate(updateArmSchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof updateArmSchemas>;
    sendSuccess(res, await s.updateArm(params.id, body, requireUser(req), contextOf(req)));
  });

  // ---- subjects
  router.get('/subjects', auth, read, validate(listSubjectsSchemas), list((q: Validated<typeof listSubjectsSchemas>['query']) => s.listSubjects(q)));
  router.post('/subjects', auth, write, validate(createSubjectSchemas), async (req, res) => {
    const { body } = req.validated as Validated<typeof createSubjectSchemas>;
    sendCreated(res, await s.createSubject(body, requireUser(req), contextOf(req)));
  });
  router.patch('/subjects/:id', auth, write, validate(updateSubjectSchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof updateSubjectSchemas>;
    sendSuccess(res, await s.updateSubject(params.id, body, requireUser(req), contextOf(req)));
  });

  return router;
}