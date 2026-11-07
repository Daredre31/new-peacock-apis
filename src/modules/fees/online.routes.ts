import { Router, type Request, type RequestHandler } from 'express';
import { AppError } from '../../common/errors/AppError';
import { authorize } from '../../common/middleware/authorize';
import { validate, type Validated } from '../../common/middleware/validate';
import { buildPageMeta, sendSuccess } from '../../common/utils/apiResponse';
import { contextOf, requireUser } from '../../common/utils/request';
import type { FinanceAnalytics } from './analytics.service';
import {
  analyticsSchemas, initializeSchemas, listReconciliationSchemas, listRefundsSchemas, quoteSchemas, reconcileSchemas,
  referenceSchemas, refundIdSchemas, revenueSchemas,
} from './online.schema';
import type { OnlinePaymentService } from './online.service';
import type { PaymentOps } from './payment.ops';
import type { RefundService } from './refund.service';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,64}$/;

function idempotencyKeyOf(req: Request): string {
  const key = req.get('idempotency-key');
  if (!key || !IDEMPOTENCY_KEY.test(key)) {
    throw new AppError('VALIDATION_ERROR', { details: [{ field: 'Idempotency-Key', issue: 'Send a unique key of 16 to 64 letters, digits, - or _ in the Idempotency-Key header' }] });
  }
  return key;
}

export function createOnlineRouter(deps: {
  online: OnlinePaymentService; analytics: FinanceAnalytics; ops: PaymentOps; refunds: RefundService;
  triggerReconcile: (actorId: string, days: number) => Promise<{ queued: boolean }>; authenticate: RequestHandler;
}): Router {
  const { online, analytics, ops, refunds, authenticate: auth } = deps;
  const router = Router();

  // These MUST be registered before /payments/:id, or "quote" and "initialize" would be read as ids.
  router.get('/payments/quote', auth, authorize('payments:initialize'), validate(quoteSchemas), async (req, res) => {
    const { query } = req.validated as Validated<typeof quoteSchemas>;
    sendSuccess(res, await online.quote(requireUser(req), query));
  });
  router.post('/payments/initialize', auth, authorize('payments:initialize'), validate(initializeSchemas), async (req, res) => {
    const key = idempotencyKeyOf(req);
    const { body } = req.validated as Validated<typeof initializeSchemas>;
    sendSuccess(res, await online.initialize(requireUser(req), body, key, contextOf(req)), { status: 201 });
  });
  router.get('/payments/:reference/status', auth, authorize('payments:check'), validate(referenceSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof referenceSchemas>;
    sendSuccess(res, await online.status(requireUser(req), params.reference));
  });
  router.post('/payments/:reference/recheck', auth, authorize('payments:check'), validate(referenceSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof referenceSchemas>;
    sendSuccess(res, await online.recheck(requireUser(req), params.reference));
  });

  router.get('/fees/analytics', auth, authorize('fees:analytics'), validate(analyticsSchemas), async (req, res) => {
    const { query } = req.validated as Validated<typeof analyticsSchemas>;
    sendSuccess(res, await analytics.forRole(requireUser(req), query.termId));
  });
  router.get('/super-admin/analytics/revenue', auth, authorize('analytics:revenue'), validate(revenueSchemas), async (req, res) => {
    const { query } = req.validated as Validated<typeof revenueSchemas>;
    sendSuccess(res, await analytics.revenue(query.months));
  });

  router.get('/fees/reconciliation', auth, authorize('payments:reconcile'), validate(listReconciliationSchemas), async (req, res) => {
    const { query } = req.validated as Validated<typeof listReconciliationSchemas>;
    const { items, total } = await ops.listRuns(query);
    sendSuccess(res, items.map((r) => ({ ...r, windowFrom: r.windowFrom.toISOString(), windowTo: r.windowTo.toISOString(), startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null })), { meta: buildPageMeta({ page: query.page, limit: query.limit, total }) });
  });
  router.post('/fees/reconciliation/run', auth, authorize('payments:reconcile'), validate(reconcileSchemas), async (req, res) => {
    const { body } = req.validated as Validated<typeof reconcileSchemas>;
    sendSuccess(res, await deps.triggerReconcile(requireUser(req).id, body.days), { status: 202 });
  });

  router.get('/refunds', auth, authorize('payments:reverse'), validate(listRefundsSchemas), async (req, res) => {
    const { query } = req.validated as Validated<typeof listRefundsSchemas>;
    const { items, total } = await refunds.list(query);
    sendSuccess(res, items.map((r) => ({ id: r.id, paymentId: r.paymentId, requestId: r.requestId, amountKobo: r.amountKobo, status: r.status, failureReason: r.failureReason, createdAt: r.createdAt.toISOString() })), { meta: buildPageMeta({ page: query.page, limit: query.limit, total }) });
  });
  router.post('/refunds/:id/cancel', auth, authorize('payments:reverse'), validate(refundIdSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof refundIdSchemas>;
    sendSuccess(res, await refunds.cancel(requireUser(req), params.id, contextOf(req)));
  });

  return router;
}