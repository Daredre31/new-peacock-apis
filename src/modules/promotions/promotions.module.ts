import { enrolmentRepository } from '../academics/enrolment.repository';
import { sessionRepository } from '../academics/session.repository';
import { structureRepository } from '../academics/structure.repository';
import type { AuthModule } from '../auth/auth.module';
import { invoiceRepository } from '../fees/invoice.repository';
import type { AnnualResultsService } from '../results/annualResults.service';
import type { SettingsService } from '../settings/settings.service';
import { studentRepository } from '../users/student.repository';
import { createPromotionRouter } from './promotion.routes';
import { createPromotionService } from './promotion.service';

export function createPromotionsModule(deps: { auth: AuthModule; settings: SettingsService; annual: AnnualResultsService }) {
  const service = createPromotionService({
    annual: deps.annual, settings: deps.settings, sessions: sessionRepository, structure: structureRepository,
    enrolments: enrolmentRepository, students: studentRepository, invoices: invoiceRepository,
  });
  return { router: createPromotionRouter({ service, authenticate: deps.auth.middleware.authenticate }), service };
}
