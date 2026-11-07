import { Router, type Request, type RequestHandler } from 'express';
import { AppError } from '../../common/errors/AppError';
import { authorize } from '../../common/middleware/authorize';
import { validate, type Validated } from '../../common/middleware/validate';
import { buildPageMeta, sendCreated, sendSuccess } from '../../common/utils/apiResponse';
import { contextOf, requireUser } from '../../common/utils/request';
import { ROLES } from '../../config/constants';
import type { CollectionsService } from './collections.service';
import type { FeeStructureService } from './feeStructure.service';
import {
  childInvoicesSchemas, createFeeStructureSchemas, defaultersSchemas, feeStructureIdSchemas, generateInvoicesSchemas, invoiceIdSchemas,
  listFeeStructuresSchemas, listInvoicesSchemas, listPaymentsSchemas, offlinePaymentSchemas, paymentIdSchemas, remindersSchemas,
  reversePaymentSchemas, updateFeeStructureSchemas,
} from './fees.schema';
import type { InvoiceService } from './invoice.service';
import type { PaymentService } from './payment.service';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,64}$/;

function idempotencyKeyOf(req: Request): string {
  const key = req.get('idempotency-key');
  if (!key || !IDEMPOTENCY_KEY.test(key)) {
    throw new AppError('VALIDATION_ERROR', {
      details: [{ field: 'Idempotency-Key', issue: 'Send a unique key of 16 to 64 letters, digits, - or _ in the Idempotency-Key header' }],
    });
  }
  return key;
}

export function createFeesRouter(deps: {
  structures: FeeStructureService; invoices: InvoiceService; payments: PaymentService; collections: CollectionsService; authenticate: RequestHandler;
}): Router {
  const { structures, invoices, payments, collections, authenticate: auth } = deps;
  const router = Router();
  // Parents have their own invoice route. The staff routes refuse them.
  const notParent = (role: string): void => {
    if (role === ROLES.PARENT) throw new AppError('FORBIDDEN');
  };

  // ---- fee structures
  router.get('/fee-structures', auth, authorize('fee-structures:read'), validate(listFeeStructuresSchemas), async (req, res) => {
    const { query } = req.validated as Validated<typeof listFeeStructuresSchemas>;
    const { items, total } = await structures.list(query);
    sendSuccess(res, items, { meta: buildPageMeta({ page: query.page, limit: query.limit, total }) });
  });
  router.post('/fee-structures', auth, authorize('fee-structures:write'), validate(createFeeStructureSchemas), async (req, res) => {
    const { body } = req.validated as Validated<typeof createFeeStructureSchemas>;
    sendCreated(res, await structures.create(requireUser(req), body, contextOf(req)));
  });
  router.patch('/fee-structures/:id', auth, authorize('fee-structures:write'), validate(updateFeeStructureSchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof updateFeeStructureSchemas>;
    sendSuccess(res, await structures.update(requireUser(req), params.id, body, contextOf(req)));
  });
  router.post('/fee-structures/:id/approve', auth, authorize('fee-structures:approve'), validate(feeStructureIdSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof feeStructureIdSchemas>;
    sendSuccess(res, await structures.approve(requireUser(req), params.id, contextOf(req)));
  });
  router.post('/fee-structures/:id/revoke-approval', auth, authorize('fee-structures:approve'), validate(feeStructureIdSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof feeStructureIdSchemas>;
    sendSuccess(res, await structures.revokeApproval(requireUser(req), params.id, contextOf(req)));
  });

  // ---- invoices
  router.post('/invoices/generate', auth, authorize('invoices:generate'), validate(generateInvoicesSchemas), async (req, res) => {
    const { body } = req.validated as Validated<typeof generateInvoicesSchemas>;
    sendSuccess(res, await invoices.generate(requireUser(req), body, contextOf(req)));
  });
  router.get('/invoices', auth, authorize('invoices:read'), validate(listInvoicesSchemas), async (req, res) => {
    notParent(requireUser(req).role);
    const { query } = req.validated as Validated<typeof listInvoicesSchemas>;
    const { items, total } = await invoices.list(query);
    sendSuccess(res, items, { meta: buildPageMeta({ page: query.page, limit: query.limit, total }) });
  });
  router.get('/invoices/:id', auth, authorize('invoices:read'), validate(invoiceIdSchemas), async (req, res) => {
    notParent(requireUser(req).role);
    const { params } = req.validated as Validated<typeof invoiceIdSchemas>;
    sendSuccess(res, await invoices.get(params.id));
  });
  router.get('/children/:id/invoices', auth, authorize('invoices:read'), validate(childInvoicesSchemas), async (req, res) => {
    const user = requireUser(req);
    if (user.role !== ROLES.PARENT) throw new AppError('FORBIDDEN');
    const { params, query } = req.validated as Validated<typeof childInvoicesSchemas>;
    const { items, total } = await invoices.forChild(user, params.id, query);
    sendSuccess(res, items, { meta: buildPageMeta({ page: query.page, limit: query.limit, total }) });
  });

  // ---- payments
  router.post('/payments/offline', auth, authorize('payments:offline'), validate(offlinePaymentSchemas), async (req, res) => {
    const key = idempotencyKeyOf(req);
    const { body } = req.validated as Validated<typeof offlinePaymentSchemas>;
    sendCreated(res, await payments.recordOffline(requireUser(req), body, key, contextOf(req)));
  });
  router.get('/payments', auth, authorize('payments:read'), validate(listPaymentsSchemas), async (req, res) => {
    const { query } = req.validated as Validated<typeof listPaymentsSchemas>;
    const { items, total } = await payments.list(requireUser(req), query);
    sendSuccess(res, items, { meta: buildPageMeta({ page: query.page, limit: query.limit, total }) });
  });
  router.get('/payments/:id', auth, authorize('payments:read'), validate(paymentIdSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof paymentIdSchemas>;
    sendSuccess(res, await payments.get(requireUser(req), params.id));
  });
  router.post('/payments/:id/reverse', auth, authorize('payments:reverse'), validate(reversePaymentSchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof reversePaymentSchemas>;
    sendSuccess(res, await payments.reverse(requireUser(req), params.id, body, contextOf(req)));
  });
  router.get('/payments/:id/receipt.pdf', auth, authorize('payments:read'), validate(paymentIdSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof paymentIdSchemas>;
    const { filename, buffer } = await payments.receipt(requireUser(req), params.id);
    res.status(200);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.end(buffer);
  });

  // ---- collections
  router.get('/fees/defaulters', auth, authorize('fees:defaulters'), validate(defaultersSchemas), async (req, res) => {
    const { query } = req.validated as Validated<typeof defaultersSchemas>;
    const { summary, rows, total } = await collections.defaulters(query);
    sendSuccess(res, { summary, rows }, { meta: buildPageMeta({ page: query.page, limit: query.limit, total }) });
  });
  router.post('/fees/reminders', auth, authorize('fees:reminders'), validate(remindersSchemas), async (req, res) => {
    const { body } = req.validated as Validated<typeof remindersSchemas>;
    sendSuccess(res, await collections.remind(requireUser(req), body, contextOf(req)));
  });

  return router;
}