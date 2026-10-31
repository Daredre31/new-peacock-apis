import { Router } from 'express';
import type { AuditService } from '../audit/audit.service';
import type { AuthModule } from '../auth/auth.module';
import type { KeyValueStore } from '../auth/keyValueStore';
import { staffRepository } from '../users/staff.repository';
import { assignmentRepository } from './assignment.repository';
import { createAssignmentRouter } from './assignment.routes';
import { createAssignmentService } from './assignment.service';
import { createSessionRouter } from './session.routes';
import { createSessionService } from './session.service';
import { sessionRepository } from './session.repository';
import { structureRepository } from './structure.repository';
import { createStructureRouter } from './structure.routes';
import { createStructureService } from './structure.service';
import { createTeacherArmsCache } from './teacherArms';

export function createAcademicsModule(deps: { audit: AuditService; auth: AuthModule; store: KeyValueStore }) {
  const authenticate = deps.auth.middleware.authenticate;

  const teacherArms = createTeacherArmsCache({
    store: deps.store,
    assignments: assignmentRepository,
    structure: structureRepository,
    sessions: sessionRepository,
  });

  const router = Router();
  router.use(createSessionRouter({ service: createSessionService({ audit: deps.audit }), authenticate }));
  router.use(createStructureRouter({ service: createStructureService({ audit: deps.audit }), authenticate }));
  router.use(
    createAssignmentRouter({
      service: createAssignmentService({
        assignments: assignmentRepository,
        staff: staffRepository,
        structure: structureRepository,
        sessions: sessionRepository,
        cache: teacherArms,
        audit: deps.audit,
      }),
      authenticate,
    }),
  );

  return { router, teacherArms };
}