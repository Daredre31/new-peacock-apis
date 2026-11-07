import { z } from 'zod';
import { MAX_KOBO } from '../../common/utils/money';
import { paginationShape } from '../../common/utils/pagination';
import { PERMISSIONS, ROLES } from '../../config/constants';
import type { OpenApiRegistry } from '../../openapi/registry';
import { PAYMENT_STATUS, type PaymentStatus } from './payment.repository';
import { REFUND_STATUS, type RefundStatus } from './refund.repository';

const objectId = z.string().regex(/^[a-f0-9]{24}$/);
const iso = z.iso.datetime();
const num = z.number().int();
const kobo = z.number().int().min(1).max(MAX_KOBO);
const reference = z.string().regex(/^PCK-[A-F0-9]{20}$/);
const paymentStatus = Object.values(PAYMENT_STATUS) as [PaymentStatus, ...PaymentStatus[]];
const refundStatus = Object.values(REFUND_STATUS) as [RefundStatus, ...RefundStatus[]];

export const quoteSchemas = { query: z.object({ invoiceId: objectId, amountKobo: z.coerce.number().int().min(1).max(MAX_KOBO).optional() }) };
const initializeBody = z.object({ invoiceId: objectId, amountKobo: kobo });
export const initializeSchemas = { body: initializeBody };
export const referenceSchemas = { params: z.object({ reference }) };
export const analyticsSchemas = { query: z.object({ termId: objectId.optional() }) };
export const revenueSchemas = { query: z.object({ months: z.coerce.number().int().min(1).max(24).default(12) }) };
export const reconcileSchemas = { body: z.object({ days: z.number().int().min(1).max(14).default(3) }) };
export const listReconciliationSchemas = { query: z.object({ ...paginationShape }) };
export const listRefundsSchemas = { query: z.object({ ...paginationShape, status: z.enum(refundStatus).optional() }) };
export const refundIdSchemas = { params: z.object({ id: objectId }) };

const statusView = z.object({
  paymentId: z.string(), reference: z.string(), status: z.enum(paymentStatus), invoiceId: z.string(), amountKobo: num, feeKobo: num, totalChargeKobo: num,
  receiptNo: z.string().nullable(), failureReason: z.string().nullable(), paidAt: iso.nullable(), canRecheck: z.boolean(),
});
const rateOrNull = z.number().nullable();
const classRow = z.object({ classArmId: z.string(), classArmName: z.string(), invoices: num, defaulters: num, settledRate: rateOrNull });

export function registerOnlineOperations(registry: OpenApiRegistry): void {
  const tags = ['fees'];
  const parent = PERMISSIONS['payments:initialize'];
  const page = (data: z.ZodType) => ({ status: 200, description: 'A page', data: z.array(data), paginated: true as const });

  registry.register({ method: 'get', path: '/payments/quote', operationId: 'quotePayment', summary: 'What an online payment would cost: the minimum part payment, the online fee and the total charge. Creates nothing', tags, roles: parent, request: { query: quoteSchemas.query }, success: { status: 200, description: 'The quote', data: z.object({ invoiceId: z.string(), totalKobo: num, balanceKobo: num, minAmountKobo: num, amountKobo: num, feeKobo: num, totalChargeKobo: num, canPayOnline: z.boolean() }) }, errors: ['NOT_FOUND'] });
  registry.register({ method: 'post', path: '/payments/initialize', operationId: 'initializePayment', summary: 'Start an online payment (full or part). Send an Idempotency-Key header (16 to 64 characters) and a NEW key for every fresh attempt. Redirect the parent to checkoutUrl. Never put card details through this API', tags, roles: parent, request: { body: initializeBody }, success: { status: 201, description: 'Started', data: statusView.extend({ checkoutUrl: z.string().nullable(), reused: z.boolean() }) }, errors: ['NOT_FOUND', 'FEE_ALREADY_PAID', 'PAYMENT_AMOUNT_INVALID', 'PAYMENT_PENDING', 'SERVICE_UNAVAILABLE', 'CONFLICT'] });
  registry.register({ method: 'get', path: '/payments/{reference}/status', operationId: 'getPaymentStatus', summary: 'Poll this from the return page every 3 seconds for up to 60 seconds. It trusts nothing from the browser. If still PENDING after that, show "pending" with the recheck button', tags, roles: PERMISSIONS['payments:check'], request: { params: referenceSchemas.params }, success: { status: 200, description: 'Status', data: statusView }, errors: ['NOT_FOUND'] });
  registry.register({ method: 'post', path: '/payments/{reference}/recheck', operationId: 'recheckPayment', summary: '"I paid but it is not showing": asks Paystack now. Limited to one real check every few seconds', tags, roles: PERMISSIONS['payments:check'], request: { params: referenceSchemas.params }, success: { status: 200, description: 'Status and the result of the check', data: statusView.extend({ outcome: z.string() }) }, errors: ['NOT_FOUND'] });

  registry.register({ method: 'get', path: '/fees/analytics', operationId: 'getFeeAnalytics', summary: 'Role-shaped. Super admin: full figures. Admin: settlement rates and defaulter counts per class, no revenue. Parent: own children by term, with a payment timeline', tags, roles: PERMISSIONS['fees:analytics'], request: { query: analyticsSchemas.query }, success: { status: 200, description: 'Analytics', data: z.union([
    z.object({ view: z.literal('PARENT'), paidThisSessionKobo: num, outstandingKobo: num, children: z.array(z.object({ studentId: z.string(), name: z.string(), paidThisSessionKobo: num, outstandingKobo: num, byTerm: z.array(z.object({ termId: z.string(), termName: z.string(), invoicedKobo: num, outstandingKobo: num })) })), timeline: z.array(z.object({ paymentId: z.string(), receiptNo: z.string().nullable(), amountKobo: num, feeKobo: num, method: z.string(), paidAt: iso.nullable(), studentName: z.string() })) }),
    z.object({ view: z.literal('ADMIN'), term: z.object({ id: z.string(), name: z.string() }).nullable(), settledRate: rateOrNull, defaulters: num, byClassArm: z.array(classRow) }),
    z.object({ view: z.literal('SUPER_ADMIN'), term: z.object({ id: z.string(), name: z.string() }).nullable(), totals: z.record(z.string(), z.number().nullable()).nullable(), byClassArm: z.array(z.record(z.string(), z.unknown())), cash: z.record(z.string(), z.number()).nullable(), byMethod: z.array(z.object({ method: z.string(), totalKobo: num, count: num })), collectedTodayKobo: num, collectedThisMonthKobo: num }),
  ]) } });
  registry.register({ method: 'get', path: '/super-admin/analytics/revenue', operationId: 'getRevenueAnalytics', summary: 'Revenue by month, online versus offline, and the method breakdown', tags, roles: PERMISSIONS['analytics:revenue'], request: { query: revenueSchemas.query }, success: { status: 200, description: 'Revenue', data: z.object({ trend: z.array(z.object({ month: z.string(), onlineKobo: num, offlineKobo: num, totalKobo: num, payments: num })), byMethod: z.array(z.object({ method: z.string(), totalKobo: num, payments: num })) }) } });

  const reconRoles = PERMISSIONS['payments:reconcile'];
  registry.register({ method: 'get', path: '/fees/reconciliation', operationId: 'listReconciliationRuns', summary: 'Results of the nightly and manual Paystack reconciliation. Every discrepancy is listed', tags, roles: reconRoles, request: { query: listReconciliationSchemas.query }, success: page(z.object({ id: z.string(), kind: z.string(), status: z.string(), windowFrom: iso, windowTo: iso, checked: num, fixed: num, complete: z.boolean(), discrepancies: z.array(z.object({ kind: z.string(), reference: z.string().nullable(), detail: z.string() })), error: z.string().nullable(), startedAt: iso, finishedAt: iso.nullable() })) });
  registry.register({ method: 'post', path: '/fees/reconciliation/run', operationId: 'runReconciliation', summary: 'Run the reconciliation now (it runs in the background). Read the result from GET /fees/reconciliation', tags, roles: reconRoles, request: { body: reconcileSchemas.body }, success: { status: 202, description: 'Started', data: z.object({ queued: z.boolean() }) } });

  const refundRoles = PERMISSIONS['payments:reverse'];
  registry.register({ method: 'get', path: '/refunds', operationId: 'listRefunds', summary: 'Online refunds and their status', tags, roles: refundRoles, request: { query: listRefundsSchemas.query }, success: page(z.object({ id: z.string(), paymentId: z.string(), requestId: z.string(), amountKobo: num, status: z.enum(refundStatus), failureReason: z.string().nullable(), createdAt: iso })) });
  registry.register({ method: 'post', path: '/refunds/{id}/cancel', operationId: 'cancelRefund', summary: 'Cancel a refund that could not be confirmed with Paystack, after checking the Paystack dashboard', tags, roles: [ROLES.SUPER_ADMIN], request: { params: refundIdSchemas.params }, success: { status: 200, description: 'Cancelled', data: z.object({ id: z.string(), status: z.enum(refundStatus) }) }, errors: ['NOT_FOUND', 'CONFLICT'] });
}