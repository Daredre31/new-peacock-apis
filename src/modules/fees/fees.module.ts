import type { ScopeService } from '../../common/scope/scope.service';
import { enrolmentRepository } from '../academics/enrolment.repository';
import { sessionRepository } from '../academics/session.repository';
import { structureRepository } from '../academics/structure.repository';
import type { AuditService } from '../audit/audit.service';
import type { AuthModule } from '../auth/auth.module';
import type { NotificationService } from '../notifications/notification.service';
import type { RequestChecks } from '../requests/request.checks';
import type { RequestEvents } from '../requests/request.events';
import type { SettingsService } from '../settings/settings.service';
import { linkRepository } from '../users/link.repository';
import { parentRepository } from '../users/parent.repository';
import { staffRepository } from '../users/staff.repository';
import { studentRepository } from '../users/student.repository';
import { userRepository } from '../users/user.repository';
import { createCollectionsService } from './collections.service';
import { feeStructureRepository } from './feeStructure.repository';
import { createFeeStructureService } from './feeStructure.service';
import { createReportGate, registerFinanceHooks } from './finance.hooks';
import { createFeesRouter } from './fees.routes';
import { invoiceRepository } from './invoice.repository';
import { createInvoiceService } from './invoice.service';
import { ledgerRepository } from './ledger.repository';
import { createLedgerService } from './ledger.service';
import { paymentRepository } from './payment.repository';
import { createPaymentService } from './payment.service';

export function createFeesModule(deps: {
  audit: AuditService; auth: AuthModule; scope: ScopeService; notifier: NotificationService;
  events: RequestEvents; requestChecks: RequestChecks; settings: SettingsService;
}) {
  const { audit, scope, notifier, settings } = deps;

  const ledger = createLedgerService({ ledger: ledgerRepository, invoices: invoiceRepository });

  const structures = createFeeStructureService({
    repo: feeStructureRepository, invoices: invoiceRepository, sessions: sessionRepository, structure: structureRepository,
    users: userRepository, notifier, audit,
  });
  const invoices = createInvoiceService({
    invoices: invoiceRepository, structures: feeStructureRepository, ledger: ledgerRepository, payments: paymentRepository,
    sessions: sessionRepository, structure: structureRepository, enrolments: enrolmentRepository, students: studentRepository,
    links: linkRepository, scope, notifier, audit,
  });
  const payments = createPaymentService({
    payments: paymentRepository, invoices: invoiceRepository, ledger, sessions: sessionRepository, structure: structureRepository,
    students: studentRepository, staff: staffRepository, links: linkRepository, scope, settings, notifier, audit,
  });
  const collections = createCollectionsService({
    invoices: invoiceRepository, structure: structureRepository, students: studentRepository, links: linkRepository,
    parents: parentRepository, users: userRepository, notifier, audit,
  });

  registerFinanceHooks({
    events: deps.events, checks: deps.requestChecks, invoices: invoiceRepository, payments: paymentRepository, ledger,
    links: linkRepository, users: userRepository, notifier, audit,
  });

  return {
    router: createFeesRouter({ structures, invoices, payments, collections, authenticate: deps.auth.middleware.authenticate }),
    reportGate: createReportGate({ invoices: invoiceRepository, settings }),
    ledger,
  };
}