import type { ScopeService } from '../../common/scope/scope.service';
import { env } from '../../config/env';
import { assignmentRepository } from '../academics/assignment.repository';
import { enrolmentRepository } from '../academics/enrolment.repository';
import { sessionRepository } from '../academics/session.repository';
import { structureRepository } from '../academics/structure.repository';
import { attendanceRepository } from '../attendance/attendance.repository';
import type { AuditService } from '../audit/audit.service';
import type { AuthModule } from '../auth/auth.module';
import type { KeyValueStore } from '../auth/keyValueStore';
import type { NotificationService } from '../notifications/notification.service';
import type { SettingsService } from '../settings/settings.service';
import { taskRepository } from '../tasks/task.repository';
import { linkRepository } from '../users/link.repository';
import { staffRepository } from '../users/staff.repository';
import { studentRepository } from '../users/student.repository';
import { userRepository } from '../users/user.repository';
import { reportCardRepository } from './reportCard.repository';
import { createReportCardsService } from './reportCards.service';
import { createResultsContext } from './results.context';
import { createResultsRouter } from './results.routes';
import { createResultsService } from './results.service';
import { scoreRepository } from './score.repository';
import { createScoresImportService } from './scores.import';
import { createScoresService } from './scores.service';
import { createStudentResultsService, openReportGate, type ReportGate } from './studentResults.service';

export function createResultsModule(deps: {
  audit: AuditService; auth: AuthModule; scope: ScopeService; notifier: NotificationService;
  settings: SettingsService; store: KeyValueStore; reportGate?: ReportGate;
}) {
  const { audit, notifier, settings } = deps;

  const ctx = createResultsContext({
    scores: scoreRepository, settings, sessions: sessionRepository, structure: structureRepository,
    assignments: assignmentRepository, enrolments: enrolmentRepository, students: studentRepository,
  });

  const scoresService = createScoresService({
    ctx, scores: scoreRepository, settings, assignments: assignmentRepository, structure: structureRepository,
    students: studentRepository, tasks: taskRepository, users: userRepository, notifier, audit,
  });
  const importService = createScoresImportService({
    store: deps.store, secret: env.REFRESH_TOKEN_SECRET, scoresService, scores: scoreRepository, settings, students: studentRepository,
  });
  const resultsService = createResultsService({
    ctx, scores: scoreRepository, settings, reportCards: reportCardRepository, attendance: attendanceRepository,
    enrolments: enrolmentRepository, links: linkRepository, notifier, audit,
  });
  const reportCardsService = createReportCardsService({ ctx, reportCards: reportCardRepository, scores: scoreRepository, attendance: attendanceRepository, audit });
  const studentResults = createStudentResultsService({
    ctx, scores: scoreRepository, reportCards: reportCardRepository, sessions: sessionRepository, staff: staffRepository,
    attendance: attendanceRepository, scope: deps.scope, gate: deps.reportGate ?? openReportGate,
    
  });

  return {
    router: createResultsRouter({
      scoresService, importService, resultsService, reportCardsService, studentResults, authenticate: deps.auth.middleware.authenticate,
    }), ctx
  };
}