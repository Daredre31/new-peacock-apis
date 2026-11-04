import { Router } from 'express';
import type { ScopeService } from '../../common/scope/scope.service';
import type { Mailer } from '../../integrations/mailer';
import type { Role } from '../../config/constants';
import { enrolmentRepository } from '../academics/enrolment.repository';
import { sessionRepository } from '../academics/session.repository';
import { structureRepository } from '../academics/structure.repository';
import type { TeacherArmsCache } from '../academics/teacherArms';
import { announcementRepository } from '../announcements/announcement.repository';
import { createAnnouncementRouter } from '../announcements/announcement.routes';
import { createAnnouncementService } from '../announcements/announcement.service';
import type { AuditService } from '../audit/audit.service';
import { attendanceRepository } from '../attendance/attendance.repository';
import { createAttendanceRouter } from '../attendance/attendance.routes';
import { createAttendanceService } from '../attendance/attendance.service';
import type { AuthModule } from '../auth/auth.module';
import { notificationRepository } from '../notifications/notification.repository';
import { createNotificationRouter } from '../notifications/notification.routes';
import { createNotificationService } from '../notifications/notification.service';
import { createRequestEvents } from '../requests/request.events';
import { requestRepository } from '../requests/request.repository';
import { createRequestRouter } from '../requests/request.routes';
import { createRequestService } from '../requests/request.service';
import { parentRepository } from '../users/parent.repository';
import { staffRepository } from '../users/staff.repository';
import { studentRepository } from '../users/student.repository';
import { userRepository } from '../users/user.repository';
import type { SettingsService } from '../settings/settings.service'

export function createCommunicationModule(deps: {
  audit: AuditService;
  auth: AuthModule;
  mailer: Mailer;
  scope: ScopeService;
  armIdsOfUser: (actor: { id: string; role: Role }) => Promise<string[]>;
  teacherArms: TeacherArmsCache;
  settings: SettingsService;
}) {
  const { audit, scope, teacherArms  } = deps;
  const authenticate = deps.auth.middleware.authenticate;

  const notifications = createNotificationService({ repo: notificationRepository, users: userRepository, mailer: deps.mailer });
  const events = createRequestEvents();

  const requestService = createRequestService({
    requests: requestRepository,
    users: userRepository,
    names: { staff: staffRepository, parents: parentRepository, students: studentRepository },
    scope,
    notifier: notifications,
    events,
    audit,
  });

  const announcementService = createAnnouncementService({
    repo: announcementRepository,
    structure: structureRepository,
    staff: staffRepository,
    users: userRepository,
    notifier: notifications,
    armIdsOfUser: deps.armIdsOfUser,
    audit,
    teacherPostsNeedApproval: async () => (await deps.settings.getPolicy()).teacherPostsNeedApproval,
  });

  const attendanceService = createAttendanceService({
    repo: attendanceRepository,
    scope,
    enrolments: enrolmentRepository,
    sessions: sessionRepository,
    structure: structureRepository,
    students: studentRepository,
    staff: staffRepository,
    teacherArms,
    notifier: notifications,
    events,
    audit,
  });

  const router = Router();
  router.use(createNotificationRouter({ service: notifications, authenticate }));
  router.use(createRequestRouter({ service: requestService, authenticate }));
  router.use(createAnnouncementRouter({ service: announcementService, authenticate }));
  router.use(createAttendanceRouter({ service: attendanceService, authenticate }));

  return { router, notifier: notifications, events, announcements: announcementService } }