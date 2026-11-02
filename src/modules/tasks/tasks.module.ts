import type { ScopeService } from '../../common/scope/scope.service';
import { assignmentRepository } from '../academics/assignment.repository';
import { enrolmentRepository } from '../academics/enrolment.repository';
import { sessionRepository } from '../academics/session.repository';
import { structureRepository } from '../academics/structure.repository';
import type { AuditService } from '../audit/audit.service';
import type { AuthModule } from '../auth/auth.module';
import type { NotificationService } from '../notifications/notification.service';
import { studentRepository } from '../users/student.repository';
import { createTaskRouter } from './task.routes';
import { taskRepository } from './task.repository';
import { createTaskService } from './task.service';

export function createTasksModule(deps: { audit: AuditService; auth: AuthModule; scope: ScopeService; notifier: NotificationService }) {
  const service = createTaskService({
    tasks: taskRepository, assignments: assignmentRepository, enrolments: enrolmentRepository,
    sessions: sessionRepository, structure: structureRepository, students: studentRepository,
    scope: deps.scope, notifier: deps.notifier, audit: deps.audit,
  });
  return { router: createTaskRouter({ service, authenticate: deps.auth.middleware.authenticate, scope: deps.scope }) };
}