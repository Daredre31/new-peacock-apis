import { Router, type RequestHandler } from 'express';
import { authorize } from '../../common/middleware/authorize';
import { validate, type Validated } from '../../common/middleware/validate';
import { buildPageMeta, sendCreated, sendSuccess } from '../../common/utils/apiResponse';
import { contextOf, requireUser } from '../../common/utils/request';
import type { CalendarService } from './calendar.service';
import { calendarSchemas, createEventSchemas, eventIdSchemas, listEventsSchemas, updateEventSchemas } from './calendar.schema';
import type { EventService } from './event.service';

export function createCalendarRouter(deps: { events: EventService; calendar: CalendarService; authenticate: RequestHandler }): Router {
  const { events, calendar, authenticate: auth } = deps;
  const router = Router();

  router.get('/events', auth, authorize('events:read'), validate(listEventsSchemas), async (req, res) => {
    const { query } = req.validated as Validated<typeof listEventsSchemas>;
    const { items, total } = await events.list(requireUser(req), { from: new Date(query.from), to: new Date(query.to) }, { page: query.page, limit: query.limit });
    sendSuccess(res, items, { meta: buildPageMeta({ page: query.page, limit: query.limit, total }) });
  });

  router.post('/events', auth, authorize('events:write'), validate(createEventSchemas), async (req, res) => {
    const { body } = req.validated as Validated<typeof createEventSchemas>;
    sendCreated(res, await events.create(requireUser(req), body, contextOf(req)));
  });

  router.patch('/events/:id', auth, authorize('events:write'), validate(updateEventSchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof updateEventSchemas>;
    sendSuccess(res, await events.update(requireUser(req), params.id, body, contextOf(req)));
  });

  router.delete('/events/:id', auth, authorize('events:write'), validate(eventIdSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof eventIdSchemas>;
    await events.remove(requireUser(req), params.id, contextOf(req));
    sendSuccess(res, null);
  });

  router.get('/calendar', auth, authorize('events:read'), validate(calendarSchemas), async (req, res) => {
    const { query } = req.validated as Validated<typeof calendarSchemas>;
    sendSuccess(res, await calendar.forUser(requireUser(req), query));
  });

  return router;
}