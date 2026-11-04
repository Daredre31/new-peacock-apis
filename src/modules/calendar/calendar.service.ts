import { AppError } from '../../common/errors/AppError';
import { daysBetween, isIsoDate } from '../../common/utils/dates';
import { ROLES, type Role } from '../../config/constants';
import type { sessionRepository } from '../academics/session.repository';
import type { AttemptService } from '../cbt/attempt.service';
import type { ExamService } from '../cbt/exam.service';
import type { TaskService } from '../tasks/task.service';
import type { linkRepository } from '../users/link.repository';
import type { EventService } from './event.service';

interface Actor { id: string; role: Role }
export type CalendarKind = 'EVENT' | 'TERM' | 'EXAM' | 'TASK_DUE';
export interface CalendarItem {
  id: string; kind: CalendarKind; title: string; start: string; end: string | null; studentId: string | null; detail: string | null;
}

const HOUR = 3_600_000;
const MAX_DAYS = 62;
const MAX_PER_SOURCE = 100;

export function createCalendarService(deps: {
  events: Pick<EventService, 'list'>;
  sessions: Pick<typeof sessionRepository, 'findCurrentSession' | 'listTerms'>;
  attempts: Pick<AttemptService, 'schedule'>;
  examService: Pick<ExamService, 'list'>;
  taskService: Pick<TaskService, 'myTasks' | 'childTasks' | 'list'>;
  links: Pick<typeof linkRepository, 'activeStudentIdsOf'>;
}) {
  const { events, sessions, attempts, examService, taskService, links } = deps;

  return {
    /** Everything in a date range (school dates, at most 62 days) that concerns this person. */
    async forUser(actor: Actor, range: { from: string; to: string }): Promise<CalendarItem[]> {
      if (!isIsoDate(range.from) || !isIsoDate(range.to) || range.to < range.from) {
        throw new AppError('VALIDATION_ERROR', { details: [{ field: 'to', issue: 'Use dates as YYYY-MM-DD, with "to" not before "from"' }] });
      }
      if (daysBetween(range.from, range.to) + 1 > MAX_DAYS) throw new AppError('VALIDATION_ERROR', { details: [{ field: 'to', issue: `At most ${MAX_DAYS} days at a time` }] });

      // School time is UTC+1, so local midnight is 23:00 UTC the evening before.
      const start = new Date(Date.parse(`${range.from}T00:00:00Z`) - HOUR);
      const end = new Date(Date.parse(`${range.to}T23:59:59.999Z`) - HOUR);
      const overlaps = (s: string, e: string | null): boolean => Date.parse(s) <= end.getTime() && Date.parse(e ?? s) >= start.getTime();
      const items: CalendarItem[] = [];

      const [eventPage, current] = await Promise.all([
        events.list(actor, { from: start, to: end }, { page: 1, limit: MAX_PER_SOURCE }),
        sessions.findCurrentSession(),
      ]);
      for (const e of eventPage.items) items.push({ id: `event:${e.id}`, kind: 'EVENT', title: e.title, start: e.startsAt, end: e.endsAt, studentId: null, detail: e.description });

      if (current) {
        const { items: terms } = await sessions.listTerms({ sessionId: current.id }, { page: 1, limit: 20, sort: 'startDate' });
        for (const t of terms) {
          const s = t.startDate.toISOString();
          const e = t.endDate.toISOString();
          if (overlaps(s, e)) items.push({ id: `term:${t.id}`, kind: 'TERM', title: t.name, start: s, end: e, studentId: null, detail: current.name });
        }
      }

      if (actor.role === ROLES.STUDENT || actor.role === ROLES.PARENT) {
        for (const x of await attempts.schedule(actor)) {
          if (overlaps(x.windowStart, x.windowEnd)) {
            items.push({ id: `exam:${x.examId}:${x.studentId}`, kind: 'EXAM', title: x.title, start: x.windowStart, end: x.windowEnd, studentId: x.studentId, detail: x.subjectName });
          }
        }
      } else {
        const { items: exams } = await examService.list(actor, { page: 1, limit: MAX_PER_SOURCE, status: 'PUBLISHED', from: start.toISOString(), to: end.toISOString() });
        for (const x of exams) items.push({ id: `exam:${x.id}`, kind: 'EXAM', title: x.title, start: x.windowStart, end: x.windowEnd, studentId: null, detail: x.subjectName });
      }

      const due = (id: string, title: string, dueAt: string, studentId: string | null, detail: string): void => {
        if (overlaps(dueAt, null)) items.push({ id: `task:${id}${studentId ? `:${studentId}` : ''}`, kind: 'TASK_DUE', title: `Due: ${title}`, start: dueAt, end: null, studentId, detail });
      };
      if (actor.role === ROLES.STUDENT) {
        for (const t of (await taskService.myTasks(actor, { page: 1, limit: MAX_PER_SOURCE })).items) due(t.id, t.title, t.dueAt, null, t.subjectName);
      } else if (actor.role === ROLES.PARENT) {
        for (const childId of await links.activeStudentIdsOf(actor.id)) {
          for (const t of (await taskService.childTasks(actor, childId, { page: 1, limit: MAX_PER_SOURCE })).items) due(t.id, t.title, t.dueAt, childId, t.subjectName);
        }
      } else if (actor.role === ROLES.TEACHER) {
        const { items: tasks } = await taskService.list(actor, { page: 1, limit: MAX_PER_SOURCE, from: start.toISOString(), to: end.toISOString() });
        for (const t of tasks) due(t.id, t.title, t.dueAt, null, `${t.subjectName}, ${t.classArmName}`);
      }

      return items.sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
    },
  };
}

export type CalendarService = ReturnType<typeof createCalendarService>;