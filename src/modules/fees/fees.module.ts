import { Router } from 'express';
import { logger } from '../../common/utils/logger';
import type { ScopeService } from '../../common/scope/scope.service';
import { env } from '../../config/env';
import { createPaystackClient } from '../../integrations/paystack';
import type { PaymentJobs } from '../../jobs/payment.jobs';
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
import { createFinanceAnalytics } from './analytics.service';
import { createCollectionsService } from './collections.service';
import { createConfirmationService } from './confirmation.service';
import { feeStructureRepository } from './feeStructure.repository';
import { createFeeStructureService } from './feeStructure.service';
import { feeChargeRepository } from './feeCharge.repository';
import { createFeeChargeService } from './feeCharge.service';
import { createFeeChargeRouter } from './feeCharge.routes';
import { createFeesRouter } from './fees.routes';
import { createFinanceReports } from './finance.reports';
import { createReportGate, registerFinanceHooks } from './finance.hooks';
import { invoiceRepository } from './invoice.repository';
import { createInvoiceService } from './invoice.service';
import { ledgerRepository } from './ledger.repository';
import { createLedgerService } from './ledger.service';
import { createOnlinePaymentService } from './online.service';
import { createOnlineRouter } from './online.routes';
import { createPaymentOps } from './payment.ops';
import { paymentRepository } from './payment.repository';
import { createPaymentService } from './payment.service';
import { paystackEventRepository } from './paystackEvent.repository';
import { reconciliationRepository } from './reconciliation.repository';
import { createRefundService } from './refund.service';
import { refundRepository } from './refund.repository';
import { createPaystackWebhookHandler, createWebhookProcessor } from './webhook';

export function createFeesModule(deps: {
  audit: AuditService; auth: AuthModule; scope: ScopeService; notifier: NotificationService;
  events: RequestEvents; requestChecks: RequestChecks; settings: SettingsService; paymentJobs: PaymentJobs;
}) {
  const { audit, scope, notifier, settings } = deps;
  const authenticate = deps.auth.middleware.authenticate;

  const paystack = createPaystackClient({ secretKey: env.PAYSTACK_SECRET_KEY, baseUrl: env.PAYSTACK_BASE_URL });
  if (paystack.mode()) logger.info({ mode: paystack.mode(), baseUrl: env.PAYSTACK_BASE_URL }, 'paystack is configured');
  else logger.warn('paystack is not configured: online payments are switched off');

  const ledger = createLedgerService({ ledger: ledgerRepository, invoices: invoiceRepository });

  const structures = createFeeStructureService({
    repo: feeStructureRepository, invoices: invoiceRepository, sessions: sessionRepository, structure: structureRepository,
    users: userRepository, notifier, audit,
  });
  const charges = createFeeChargeService({
    repo: feeChargeRepository, invoices: invoiceRepository, ledger: ledgerRepository, sessions: sessionRepository, structure: structureRepository,
    enrolments: enrolmentRepository, students: studentRepository, links: linkRepository, users: userRepository, notifier, audit,
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

  const confirmation = createConfirmationService({ payments: paymentRepository, paystack, ledger, links: linkRepository, users: userRepository, notifier, audit });
  const refunds = createRefundService({ refunds: refundRepository, payments: paymentRepository, ledger, paystack, links: linkRepository, users: userRepository, notifier, audit });

  registerFinanceHooks({
    events: deps.events, checks: deps.requestChecks, invoices: invoiceRepository, payments: paymentRepository, ledger,
    links: linkRepository, users: userRepository, notifier, audit,
    startOnlineRefund: (event, payment) => refunds.startOnlineRefund(event, payment),
    reservedRefunds: (paymentId) => refundRepository.reservedTotal(paymentId),
  });

  const processor = createWebhookProcessor({ events: paystackEventRepository, confirmation, refunds, users: userRepository, notifier, audit });
  // After the 200 is sent, the event is processed in the background. Anything that fails is retried by the sweep.
  const dispatch = (eventId: string): void => {
    void processor.process(eventId).catch((err: unknown) => logger.error({ err, eventId }, 'webhook processing crashed'));
  };
  const webhook = createPaystackWebhookHandler({ secretKey: env.PAYSTACK_SECRET_KEY, events: paystackEventRepository, dispatch });

  const ops = createPaymentOps({
    payments: paymentRepository, invoices: invoiceRepository, ledger: ledgerRepository, events: paystackEventRepository,
    runs: reconciliationRepository, processor, confirmation, refunds, paystack, users: userRepository, notifier,
  });
  deps.paymentJobs.register({
    sweep: () => ops.sweep(),
    reconcile: async (days, triggeredBy, kind) => { await ops.reconcile({ days, triggeredBy, kind }); },
  });

  const online = createOnlinePaymentService({
    payments: paymentRepository, invoices: invoiceRepository, users: userRepository, students: studentRepository, settings, scope,
    confirmation, paystack, returnUrl: env.PAYMENT_RETURN_URL, audit,
  });
  const analytics = createFinanceAnalytics({
    invoices: invoiceRepository, ledger: ledgerRepository, payments: paymentRepository, sessions: sessionRepository,
    structure: structureRepository, students: studentRepository, links: linkRepository,
  });

  const triggerReconcile = async (actorId: string, days: number): Promise<{ queued: boolean }> => {
    if (!(await deps.paymentJobs.scheduler.enqueueReconcile(days, actorId))) {
      void ops.reconcile({ days, triggeredBy: actorId, kind: 'MANUAL' }).catch((err: unknown) => logger.error({ err }, 'manual reconciliation crashed'));
    }
    return { queued: true };
  };

  const router = Router();
  router.use(createOnlineRouter({ online, analytics, ops, refunds, triggerReconcile, authenticate }));
  router.use(createFeeChargeRouter({ charges, authenticate }));
  router.use(createFeesRouter({ structures, invoices, payments, collections, authenticate }));

  return {
    router, webhook, ledger,
    reportGate: createReportGate({ invoices: invoiceRepository, settings }),
    financeWidgets: analytics.widgets,
    financeReports: createFinanceReports({ analytics, collections, sessions: sessionRepository, structure: structureRepository }),
  };
}