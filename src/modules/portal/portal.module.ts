import { Router } from 'express';
import {
  createReportRateLimiter, createThreadRateLimiter, type RedisLike,
} from '../../common/middleware/rateLimiter';
import type { ScopeService } from '../../common/scope/scope.service';
import type { Role } from '../../config/constants';
import type { ReportJobs } from '../../jobs/report.jobs';
import { assignmentRepository } from '../academics/assignment.repository';
import { enrolmentRepository } from '../academics/enrolment.repository';
import { sessionRepository } from '../academics/session.repository';
import { structureRepository } from '../academics/structure.repository';
import type { TeacherArmsCache } from '../academics/teacherArms';
import { announcementRepository } from '../announcements/announcement.repository';
import type { AnnouncementService } from '../announcements/announcement.service';
import type { AuditService } from '../audit/audit.service';
import { attendanceRepository } from '../attendance/attendance.repository';
import type { AuthModule } from '../auth/auth.module';
import type { KeyValueStore } from '../auth/keyValueStore';
import type { AttemptService } from '../cbt/attempt.service';
import { examRepository } from '../cbt/exam.repository';
import type { ExamService } from '../cbt/exam.service';
import { createCalendarRouter } from '../calendar/calendar.routes';
import { createCalendarService } from '../calendar/calendar.service';
import { eventRepository } from '../calendar/event.repository';
import { createEventService } from '../calendar/event.service';
import { createDashboardRouter } from '../dashboards/dashboard.routes';
import { createDashboardService, noFinance, type FinanceWidgets } from '../dashboards/dashboard.service';
import { createTeacherPortalService } from '../dashboards/teacher.service';
import type { NotificationService } from '../notifications/notification.service';
import { requestRepository } from '../requests/request.repository';
import { createReportGenerators } from '../reports/report.generators';
import { reportRepository } from '../reports/report.repository';
import { createReportRouter } from '../reports/report.routes';
import { createReportService } from '../reports/report.service';
import type { ResultsContext } from '../results/results.context';
import type { SettingsService } from '../settings/settings.service';
import { taskRepository } from '../tasks/task.repository';
import type { TaskService } from '../tasks/task.service';
import { createThreadRouter } from '../threads/thread.routes';
import { createThreadService } from '../threads/thread.service';
import { threadRepository } from '../threads/thread.repository';
import { timetableRepository } from '../timetable/timetable.repository';
import { createTimetableRouter } from '../timetable/timetable.routes';
import { createTimetableService } from '../timetable/timetable.service';
import { linkRepository } from '../users/link.repository';
import { parentRepository } from '../users/parent.repository';
import { staffRepository } from '../users/staff.repository';
import { studentRepository } from '../users/student.repository';
import { userRepository } from '../users/user.repository';

export function createPortalModule(deps: {
  audit: AuditService; auth: AuthModule; store: KeyValueStore; rateLimitRedis: RedisLike | null;
  scope: ScopeService; armIdsOfUser: (actor: { id: string; role: Role }) => Promise<string[]>; teacherArms: TeacherArmsCache;
  notifier: NotificationService; announcements: AnnouncementService; taskService: TaskService;
  attempts: AttemptService; examService: ExamService; resultsCtx: ResultsContext; settings: SettingsService;
  reportJobs: ReportJobs; finance?: FinanceWidgets;
}) {
  const { audit, store, scope, armIdsOfUser, teacherArms, notifier, settings } = deps;
  const authenticate = deps.auth.middleware.authenticate;

  const timetable = createTimetableService({
    repo: timetableRepository, structure: structureRepository, assignments: assignmentRepository,
    sessions: sessionRepository, staff: staffRepository, armIdsOfUser, audit,
  });

  const events = createEventService({ repo: eventRepository, structure: structureRepository, armIdsOfUser, audit });
  const calendar = createCalendarService({
    events, sessions: sessionRepository, attempts: deps.attempts, examService: deps.examService,
    taskService: deps.taskService, links: linkRepository,
  });

  const threads = createThreadService({
    threads: threadRepository, scope, links: linkRepository, enrolments: enrolmentRepository, sessions: sessionRepository,
    structure: structureRepository, assignments: assignmentRepository, staff: staffRepository, parents: parentRepository,
    students: studentRepository, users: userRepository, notifier, audit,
  });

  const reports = createReportService({
    repo: reportRepository,
    generators: createReportGenerators({
      sessions: sessionRepository, enrolments: enrolmentRepository, students: studentRepository,
      attendance: attendanceRepository, structure: structureRepository, results: deps.resultsCtx,
    }),
    scheduler: deps.reportJobs.scheduler, notifier, audit,
  });
  // What the background report jobs actually do.
  deps.reportJobs.register({ generate: (id) => reports.generate(id), sweep: () => reports.sweep() });

  const dashboards = createDashboardService({
    students: studentRepository, staff: staffRepository, parents: parentRepository, structure: structureRepository,
    sessions: sessionRepository, attendance: attendanceRepository, enrolments: enrolmentRepository, requests: requestRepository,
    exams: examRepository, announcementRepo: announcementRepository, links: linkRepository, tasks: taskRepository,
    assignments: assignmentRepository, timetable, taskService: deps.taskService, attempts: deps.attempts,
    announcements: deps.announcements, notifications: notifier, teacherArms, settings, store, finance: deps.finance ?? noFinance,
  });
  const teacherPortal = createTeacherPortalService({
    sessions: sessionRepository, assignments: assignmentRepository, teacherArms, structure: structureRepository,
    enrolments: enrolmentRepository, students: studentRepository, attendance: attendanceRepository,
    links: linkRepository, parents: parentRepository, users: userRepository,
  });

  const router = Router();
  router.use(createTimetableRouter({ service: timetable, authenticate }));
  router.use(createCalendarRouter({ events, calendar, authenticate }));
  router.use(createThreadRouter({ service: threads, authenticate, limiter: createThreadRateLimiter(deps.rateLimitRedis) }));
  router.use(createReportRouter({ service: reports, authenticate, limiter: createReportRateLimiter(deps.rateLimitRedis) }));
  router.use(createDashboardRouter({ service: dashboards, teacher: teacherPortal, authenticate }));

  return { router };
}