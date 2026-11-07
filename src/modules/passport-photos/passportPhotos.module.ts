import type { ScopeService } from '../../common/scope/scope.service';
import type { ImageStore } from '../../integrations/imageStore';
import type { AuditService } from '../audit/audit.service';
import type { AuthModule } from '../auth/auth.module';
import type { NotificationService } from '../notifications/notification.service';
import { linkRepository } from '../users/link.repository';
import { studentRepository } from '../users/student.repository';
import { createPassportPhotoRouter } from './submission.routes';
import { submissionRepository } from './submission.repository';
import { createPassportPhotoService } from './submission.service';

/** Students and parents propose a passport photo; an admin approves it. The admin's own direct upload (in the users module) is unchanged. */
export function createPassportPhotosModule(deps: {
  audit: AuditService;
  auth: AuthModule;
  scope: ScopeService;
  notifier: NotificationService;
  images: ImageStore;
}) {
  const service = createPassportPhotoService({
    repo: submissionRepository, students: studentRepository, links: linkRepository,
    images: deps.images, notifier: deps.notifier, audit: deps.audit,
  });
  return { router: createPassportPhotoRouter({ service, authenticate: deps.auth.middleware.authenticate, scope: deps.scope }), service };
}
