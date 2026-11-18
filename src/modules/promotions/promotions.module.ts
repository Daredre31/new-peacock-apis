import { enrolmentRepository } from '../academics/enrolment.repository';
import { sessionRepository } from '../academics/session.repository';
import { structureRepository } from '../academics/structure.repository';
import type { AuditService } from '../audit/audit.service';
import type { AuthModule } from '../auth/auth.module';
import { invoiceRepository } from '../fees/invoice.repository';
import type { NotificationService } from '../notifications/notification.service';
import type { AnnualResultsService } from '../results/annualResults.service';
import type { SettingsService } from '../settings/settings.service';
import { linkRepository } from '../users/link.repository';
import { studentRepository } from '../users/student.repository';
import { userRepository } from '../users/user.repository';
import { createPromotionRouter } from './promotion.routes';
import { createPromotionService } from './promotion.service';

export function createPromotionsModule(deps: { audit: AuditService; auth: AuthModule; settings: SettingsService; annual: AnnualResultsService; notifier: NotificationService }) {
  const service = createPromotionService({
    annual: deps.annual, settings: deps.settings, sessions: sessionRepository, structure: structureRepository,
    enrolments: enrolmentRepository, students: studentRepository, invoices: invoiceRepository,
    users: userRepository, links: linkRepository, notifier: deps.notifier, audit: deps.audit,
  });
  return { router: createPromotionRouter({ service, authenticate: deps.auth.middleware.authenticate }), service };
}
