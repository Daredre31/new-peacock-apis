import { Router } from 'express';
import { createClaimRateLimiter, type RedisLike } from '../../common/middleware/rateLimiter';
import { createScopeService } from '../../common/scope';
import { env } from '../../config/env';
import { enrolmentRepository } from '../academics/enrolment.repository';
import { sessionRepository } from '../academics/session.repository';
import { structureRepository } from '../academics/structure.repository';
import type { TeacherArmsCache } from '../academics/teacherArms';
import type { AuditService } from '../audit/audit.service';
import type { AuthModule } from '../auth/auth.module';
import type { KeyValueStore } from '../auth/keyValueStore';
import { passwordService } from '../auth/password.service';
import { linkRepository } from './link.repository';
import { createLinkService } from './link.service';
import { parentRepository } from './parent.repository';
import { createParentRouter } from './parent.routes';
import { createParentService } from './parent.service';
import { createScopePorts } from './scope.ports';
import { createSecurityRouter } from './security.routes';
import { createSecurityService } from './security.service';
import { createStaffRouter } from './staff.routes';
import { ADMIN_STAFF_CONFIG, TEACHER_STAFF_CONFIG } from './staff.schema';
import { createStaffService } from './staff.service';
import { staffRepository } from './staff.repository';
import { createStudentImportService } from './student.import';
import { studentRepository } from './student.repository';
import { createStudentRouter } from './student.routes';
import { createStudentService } from './student.service';
import { userRepository } from './user.repository';

export function createUsersModule(deps: {
  audit: AuditService;
  auth: AuthModule;
  store: KeyValueStore;
  rateLimitRedis: RedisLike | null;
  teacherArms: TeacherArmsCache;
}) {
  const { audit, auth, store, teacherArms } = deps;
  const authenticate = auth.middleware.authenticate;
  const common = { passwords: passwordService, credentials: auth.credentials, tokens: auth.tokens, audit };

  const scope = createScopeService(
    createScopePorts({
      links: linkRepository,
      students: studentRepository,
      enrolments: enrolmentRepository,
      sessions: sessionRepository,
      teacherArms,
    }),
  );

  const staffService = createStaffService({ users: userRepository, staff: staffRepository, ...common });
  const studentService = createStudentService({
    users: userRepository,
    students: studentRepository,
    enrolments: enrolmentRepository,
    sessions: sessionRepository,
    structure: structureRepository,
    teacherArmIds: (teacherUserId) => teacherArms.armIdsOf(teacherUserId),
    ...common,
  });
  const importService = createStudentImportService({
    store,
    secret: env.REFRESH_TOKEN_SECRET,
    students: studentService,
    users: userRepository,
    structure: structureRepository,
    audit,
  });
  const parentService = createParentService({ users: userRepository, parents: parentRepository, ...common });
  const linkService = createLinkService({
    links: linkRepository,
    parents: parentRepository,
    students: studentRepository,
    studentViews: studentService,
    store,
    secret: env.REFRESH_TOKEN_SECRET,
    audit,
  });
  const securityService = createSecurityService({
    users: userRepository,
    passwords: passwordService,
    tokens: auth.tokens,
    audit,
  });

  const router = Router();
  router.use(createStaffRouter(ADMIN_STAFF_CONFIG, { service: staffService, authenticate, scope }));
  router.use(createStaffRouter(TEACHER_STAFF_CONFIG, { service: staffService, authenticate, scope }));
  router.use(createStudentRouter({ service: studentService, importService, authenticate, scope }));
  router.use(
    createParentRouter({
      parentService,
      linkService,
      authenticate,
      claimLimiter: createClaimRateLimiter(deps.rateLimitRedis),
      scope,
    }),
  );
  router.use(createSecurityRouter({ service: securityService, authenticate }));

  return { router };
}