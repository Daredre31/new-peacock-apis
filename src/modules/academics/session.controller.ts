import type { RequestHandler } from 'express';
import type { Validated } from '../../common/middleware/validate';
import { buildPageMeta, sendCreated, sendSuccess } from '../../common/utils/apiResponse';
import { contextOf, requireUser } from '../../common/utils/request';
import type {
  createSessionSchemas,
  createTermSchemas,
  idParamsSchemas,
  listSessionsSchemas,
  listTermsSchemas,
  updateSessionSchemas,
  updateTermSchemas,
} from './session.schema';
import type { SessionService } from './session.service';

interface PatchBody {
  name?: string | undefined;
  startDate?: string | undefined;
  endDate?: string | undefined;
}

/** Keeps only the fields that were sent, and turns the dates into Date objects. */
function toPatch(body: PatchBody) {
  return {
    ...(body.name !== undefined && { name: body.name }),
    ...(body.startDate !== undefined && { startDate: new Date(body.startDate) }),
    ...(body.endDate !== undefined && { endDate: new Date(body.endDate) }),
  };
}

export function createSessionController(service: SessionService) {
  const listSessions: RequestHandler = async (req, res) => {
    const { query } = req.validated as Validated<typeof listSessionsSchemas>;
    const { items, total } = await service.listSessions(query);
    sendSuccess(res, items, { meta: buildPageMeta({ page: query.page, limit: query.limit, total }) });
  };

  const createSession: RequestHandler = async (req, res) => {
    const { body } = req.validated as Validated<typeof createSessionSchemas>;
    const created = await service.createSession(
      { name: body.name, startDate: new Date(body.startDate), endDate: new Date(body.endDate) },
      requireUser(req),
      contextOf(req),
    );
    sendCreated(res, created);
  };

  const updateSession: RequestHandler = async (req, res) => {
    const { params, body } = req.validated as Validated<typeof updateSessionSchemas>;
    sendSuccess(res, await service.updateSession(params.id, toPatch(body), requireUser(req), contextOf(req)));
  };

  const listTerms: RequestHandler = async (req, res) => {
    const { query } = req.validated as Validated<typeof listTermsSchemas>;
    const { items, total } = await service.listTerms(query);
    sendSuccess(res, items, { meta: buildPageMeta({ page: query.page, limit: query.limit, total }) });
  };

  const createTerm: RequestHandler = async (req, res) => {
    const { body } = req.validated as Validated<typeof createTermSchemas>;
    const created = await service.createTerm(
      {
        sessionId: body.sessionId,
        name: body.name,
        startDate: new Date(body.startDate),
        endDate: new Date(body.endDate),
      },
      requireUser(req),
      contextOf(req),
    );
    sendCreated(res, created);
  };

  const updateTerm: RequestHandler = async (req, res) => {
    const { params, body } = req.validated as Validated<typeof updateTermSchemas>;
    sendSuccess(res, await service.updateTerm(params.id, toPatch(body), requireUser(req), contextOf(req)));
  };

  const termAction =
    (run: (id: string, actor: Express.AuthUser, ctx: ReturnType<typeof contextOf>) => Promise<unknown>): RequestHandler =>
    async (req, res) => {
      const { params } = req.validated as Validated<typeof idParamsSchemas>;
      sendSuccess(res, await run(params.id, requireUser(req), contextOf(req)));
    };

  return {
    listSessions,
    createSession,
    updateSession,
    listTerms,
    createTerm,
    updateTerm,
    setCurrentTerm: termAction((id, actor, ctx) => service.setCurrentTerm(id, actor, ctx)),
    closeTerm: termAction((id, actor, ctx) => service.closeTerm(id, actor, ctx)),
    reopenTerm: termAction((id, actor, ctx) => service.reopenTerm(id, actor, ctx)),
  };
}