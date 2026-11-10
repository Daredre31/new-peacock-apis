import type { Router } from 'express';
import type { RedisLike } from '../../common/middleware/rateLimiter';
import { env } from '../../config/env';
import type { ImageStore } from '../../integrations/imageStore';
import type { Mailer } from '../../integrations/mailer';
import { createPaystackClient, type PaystackClient } from '../../integrations/paystack';
import { enrolmentRepository } from '../academics/enrolment.repository';
import { sessionRepository } from '../academics/session.repository';
import { structureRepository } from '../academics/structure.repository';
import type { AuditService } from '../audit/audit.service';
import type { AuthModule } from '../auth/auth.module';
import type { NotificationService } from '../notifications/notification.service';
import type { LinkService } from '../users/link.service';
import type { ParentService } from '../users/parent.service';
import { studentRepository } from '../users/student.repository';
import type { StudentService } from '../users/student.service';
import { userRepository } from '../users/user.repository';
import { createAdmissionService, type AdmissionService } from './admission.service';
import { createAdmissionRouter } from './admission.routes';
import { applicationRepository } from './application.repository';

/** The page Paystack sends the parent back to. The frontend can change this path. */
const RETURN_PATH = '/admission/status';

export function createAdmissionsModule(deps: {
  audit: AuditService; auth: AuthModule; notifier: NotificationService; mailer: Mailer; images: ImageStore; rateLimitRedis: RedisLike | null;
  students: StudentService; parents: ParentService; links: LinkService;
  /** Tests give a fake Paystack. */
  paystack?: PaystackClient;
}): { router: Router; service: AdmissionService; payments: { confirm: AdmissionService['confirm'] } } {
  const paystack = deps.paystack ?? createPaystackClient({ secretKey: env.PAYSTACK_SECRET_KEY, baseUrl: env.PAYSTACK_BASE_URL });
  const service = createAdmissionService({
    repo: applicationRepository, paystack, mailer: deps.mailer, images: deps.images, structure: structureRepository, sessions: sessionRepository,
    enrolments: enrolmentRepository, students: deps.students, studentRecords: studentRepository, parents: deps.parents, links: deps.links,
    users: userRepository, notifier: deps.notifier, returnUrl: `${env.CORS_ORIGIN}${RETURN_PATH}`, audit: deps.audit,
  });
  const router = createAdmissionRouter({ service, authenticate: deps.auth.middleware.authenticate, redis: deps.rateLimitRedis });
  return { router, service, payments: { confirm: service.confirm } };
}
