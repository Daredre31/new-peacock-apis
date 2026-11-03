import type { ScopeService } from '../../common/scope/scope.service';
import { env } from '../../config/env';
import type { ExamJobs } from '../../jobs/exam.jobs';
import { assignmentRepository } from '../academics/assignment.repository';
import { enrolmentRepository } from '../academics/enrolment.repository';
import { sessionRepository } from '../academics/session.repository';
import { structureRepository } from '../academics/structure.repository';
import type { AuditService } from '../audit/audit.service';
import type { AuthModule } from '../auth/auth.module';
import type { KeyValueStore } from '../auth/keyValueStore';
import type { NotificationService } from '../notifications/notification.service';
import { scoreRepository } from '../results/score.repository';
import type { SettingsService } from '../settings/settings.service';
import { linkRepository } from '../users/link.repository';
import { staffRepository } from '../users/staff.repository';
import { studentRepository } from '../users/student.repository';
import { userRepository } from '../users/user.repository';
import { createAnalyticsService } from './analytics.service';
import { attemptRepository } from './attempt.repository';
import { createAttemptService } from './attempt.service';
import { createCbtRouter } from './cbt.routes';
import { examRepository } from './exam.repository';
import { createExamService } from './exam.service';
import { createPaperCache } from './paper.cache';
import { createQuestionImportService } from './question.import';
import { questionRepository } from './question.repository';

export function createCbtModule(deps: {
  audit: AuditService; auth: AuthModule; scope: ScopeService; notifier: NotificationService;
  settings: SettingsService; store: KeyValueStore; jobs: ExamJobs;
}) {
  const paper = createPaperCache({ store: deps.store, questions: questionRepository });

  const attemptService = createAttemptService({
    exams: examRepository, questions: questionRepository, attempts: attemptRepository, enrolments: enrolmentRepository,
    sessions: sessionRepository, structure: structureRepository, students: studentRepository, links: linkRepository,
    scope: deps.scope, paper, scheduler: deps.jobs.scheduler,
  });
  // What the background jobs actually do.
  deps.jobs.register({ autoSubmit: (attemptId) => attemptService.autoSubmit(attemptId), sweep: () => attemptService.sweep() });

  const examService = createExamService({
    exams: examRepository, questions: questionRepository, attempts: attemptRepository, enrolments: enrolmentRepository,
    sessions: sessionRepository, structure: structureRepository, assignments: assignmentRepository, staff: staffRepository,
    settings: deps.settings, scores: scoreRepository, users: userRepository, notifier: deps.notifier, paper,
    finalizeOverdueFor: (examId) => attemptService.finalizeOverdueFor(examId), audit: deps.audit,
  });
  const importService = createQuestionImportService({
    store: deps.store, secret: env.REFRESH_TOKEN_SECRET, exams: examRepository, questions: questionRepository, paper, audit: deps.audit,
  });
  const analytics = createAnalyticsService({
    exams: examRepository, questions: questionRepository, attempts: attemptRepository, enrolments: enrolmentRepository, students: studentRepository,
  });

  return {
    router: createCbtRouter({ exams: examService, attempts: attemptService, analytics, importService, authenticate: deps.auth.middleware.authenticate }),
  };
}