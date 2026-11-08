import { z } from 'zod';
import { MAX_KOBO } from '../../common/utils/money';
import { paginationShape } from '../../common/utils/pagination';
import { PERMISSIONS } from '../../config/constants';
import type { OpenApiRegistry } from '../../openapi/registry';
import { FEE_STRUCTURE_STATUS, type FeeStructureStatus } from './feeStructure.repository';
import { INVOICE_STATUS, type InvoiceStatus } from './invoice.repository';
import { PAYMENT_METHODS, PAYMENT_STATUS, type PaymentStatus } from './payment.repository';

const objectId = z.string().regex(/^[a-f0-9]{24}$/);
const idParams = z.object({ id: objectId });
const iso = z.iso.datetime();
const num = z.number().int();
const kobo = z.number().int().min(1).max(MAX_KOBO);
const flag = z.enum(['true', 'false']).transform((value) => value === 'true');
const structureStatus = Object.values(FEE_STRUCTURE_STATUS) as [FeeStructureStatus, ...FeeStructureStatus[]];
const invoiceStatus = Object.values(INVOICE_STATUS) as [InvoiceStatus, ...InvoiceStatus[]];
const paymentStatus = Object.values(PAYMENT_STATUS) as [PaymentStatus, ...PaymentStatus[]];
const item = z.object({ name: z.string().trim().min(1).max(60), amountKobo: kobo });
const items = z.array(item).min(1).max(30);

// ---- fee structures
export const listFeeStructuresQuery = z.object({ ...paginationShape, termId: objectId.optional(), classId: objectId.optional(), status: z.enum(structureStatus).optional() });
export const listFeeStructuresSchemas = { query: listFeeStructuresQuery };
const createStructureBody = z.object({ termId: objectId, classId: objectId, name: z.string().trim().min(3).max(100), items });
export const createFeeStructureSchemas = { body: createStructureBody };
const updateStructureBody = z.object({ name: z.string().trim().min(3).max(100).optional(), items: items.optional() });
export const updateFeeStructureSchemas = { params: idParams, body: updateStructureBody };
export const feeStructureIdSchemas = { params: idParams };

// ---- invoices
const generateBody = z.object({ classId: objectId, termId: objectId, dueDate: z.iso.date() });
export const generateInvoicesSchemas = { body: generateBody };
export const listInvoicesQuery = z.object({
  ...paginationShape, sort: z.enum(['-createdAt', 'dueDate', '-balanceKobo']).default('-createdAt'),
  termId: objectId.optional(), classArmId: objectId.optional(), status: z.enum(invoiceStatus).optional(),
  studentId: objectId.optional(), overdue: flag.optional(), q: z.string().trim().min(1).max(20).optional(),
});
export const listInvoicesSchemas = { query: listInvoicesQuery };
export const invoiceIdSchemas = { params: idParams };
export const childInvoicesSchemas = { params: idParams, query: z.object({ ...paginationShape, termId: objectId.optional() }) };

// ---- payments
const offlineBody = z.object({
  invoiceId: objectId, amountKobo: kobo, method: z.enum(['CASH', 'TRANSFER', 'POS']),
  /** Required for TRANSFER and POS: the bank or slip reference. Optional for CASH: a receipt book number. */
  externalReference: z.string().trim().min(4).max(64).optional(),
  paidOn: z.iso.date().optional(), note: z.string().trim().max(300).optional(),
});
export const offlinePaymentSchemas = { body: offlineBody };
export const listPaymentsQuery = z.object({
  ...paginationShape, invoiceId: objectId.optional(), studentId: objectId.optional(), status: z.enum(paymentStatus).optional(),
  method: z.enum(PAYMENT_METHODS).optional(), from: iso.optional(), to: iso.optional(),
});
export const listPaymentsSchemas = { query: listPaymentsQuery };
export const paymentIdSchemas = { params: idParams };
const reverseBody = z.object({ reason: z.string().trim().min(5).max(500) });
export const reversePaymentSchemas = { params: idParams, body: reverseBody };

// ---- collections
export const defaultersQuery = z.object({ ...paginationShape, termId: objectId.optional(), classArmId: objectId.optional(), includeNotDue: flag.optional() });
export const defaultersSchemas = { query: defaultersQuery };
const remindBody = z.object({ termId: objectId.optional(), classArmId: objectId.optional(), studentIds: z.array(objectId).max(200).optional() });
export const remindersSchemas = { body: remindBody };

// ---- views
const structureView = z.object({
  id: z.string(), name: z.string(), classId: z.string(), className: z.string(), termId: z.string(), termName: z.string(), sessionId: z.string(),
  items: z.array(item), totalKobo: num, status: z.enum(structureStatus), approvedAt: iso.nullable(), createdAt: iso,
});
const invoiceView = z.object({
  id: z.string(), number: z.string(), studentId: z.string(), studentName: z.string(), admissionNo: z.string(), classArmId: z.string(), classArmName: z.string(),
  termId: z.string(), termName: z.string(), items: z.array(item), totalKobo: num, paidKobo: num, balanceKobo: num, creditKobo: num,
  kind: z.enum(['TERM_FEES', 'ADDITIONAL']), title: z.string().nullable(),
  status: z.enum(invoiceStatus), dueDate: z.string(), overdue: z.boolean(), createdAt: iso,
});
const paymentSummary = z.object({ id: z.string(), method: z.enum(PAYMENT_METHODS), status: z.enum(paymentStatus), amountKobo: num, feeKobo: num, receiptNo: z.string().nullable(), paidAt: iso.nullable() });
const paymentView = z.object({
  id: z.string(), reference: z.string(), receiptNo: z.string().nullable(), invoiceId: z.string(), invoiceNumber: z.string(), studentId: z.string(), studentName: z.string(),
  method: z.enum(PAYMENT_METHODS), status: z.enum(paymentStatus), amountKobo: num, feeKobo: num, totalChargeKobo: num, refundedKobo: num,
  externalReference: z.string().nullable(), paidAt: iso.nullable(), balanceAfterKobo: num.nullable(),
  recordedBy: z.object({ id: z.string(), name: z.string() }).nullable(), reverseReason: z.string().nullable(), createdAt: iso,
});

export function registerFeeOperations(registry: OpenApiRegistry): void {
  const tags = ['fees'];
  const page = (data: z.ZodType) => ({ status: 200, description: 'A page', data: z.array(data), paginated: true as const });

  registry.register({ method: 'get', path: '/fee-structures', operationId: 'listFeeStructures', summary: 'Fee structures (price lists per class and term). Amounts are in kobo', tags, roles: PERMISSIONS['fee-structures:read'], request: { query: listFeeStructuresQuery }, success: page(structureView) });
  registry.register({ method: 'post', path: '/fee-structures', operationId: 'createFeeStructure', summary: 'Create a draft price list for a class and term. One per class per term', tags, roles: PERMISSIONS['fee-structures:write'], request: { body: createStructureBody }, success: { status: 201, description: 'Created', data: structureView }, errors: ['CONFLICT'] });
  registry.register({ method: 'patch', path: '/fee-structures/{id}', operationId: 'updateFeeStructure', summary: 'Change a draft. An approved structure is frozen', tags, roles: PERMISSIONS['fee-structures:write'], request: { params: idParams, body: updateStructureBody }, success: { status: 200, description: 'Updated', data: structureView }, errors: ['NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'post', path: '/fee-structures/{id}/approve', operationId: 'approveFeeStructure', summary: 'The super admin approves a structure so invoices can be generated from it', tags, roles: PERMISSIONS['fee-structures:approve'], request: { params: idParams }, success: { status: 200, description: 'Approved', data: structureView }, errors: ['NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'post', path: '/fee-structures/{id}/revoke-approval', operationId: 'revokeFeeStructureApproval', summary: 'Reopen an approved structure, only while no invoice has been generated from it', tags, roles: PERMISSIONS['fee-structures:approve'], request: { params: idParams }, success: { status: 200, description: 'Reopened', data: structureView }, errors: ['NOT_FOUND', 'CONFLICT'] });

  registry.register({ method: 'post', path: '/invoices/generate', operationId: 'generateInvoices', summary: 'Generate invoices for every active student in a class this term. Safe to repeat: students who already have one are skipped', tags, roles: PERMISSIONS['invoices:generate'], request: { body: generateBody }, success: { status: 200, description: 'Result', data: z.object({ students: num, created: num, skipped: num, failed: num, totalKobo: num }) }, errors: ['CONFLICT'] });
  registry.register({ method: 'get', path: '/invoices', operationId: 'listInvoices', summary: 'All invoices with balances', tags, roles: ['SUPER_ADMIN', 'ADMIN'], request: { query: listInvoicesQuery }, success: page(invoiceView) });
  registry.register({ method: 'get', path: '/invoices/{id}', operationId: 'getInvoice', summary: 'One invoice with its ledger, its payments and a check that the balance adds up', tags, roles: ['SUPER_ADMIN', 'ADMIN'], request: { params: idParams }, success: { status: 200, description: 'The invoice', data: invoiceView.extend({ ledger: z.array(z.object({ id: z.string(), type: z.string(), amountKobo: num, note: z.string().nullable(), paymentId: z.string().nullable(), requestId: z.string().nullable(), createdAt: iso })), payments: z.array(paymentSummary), ledgerBalanceKobo: num, consistent: z.boolean() }) }, errors: ['NOT_FOUND'] });
  registry.register({ method: 'get', path: '/children/{id}/invoices', operationId: 'listChildInvoices', summary: "A linked child's invoices, with payments and receipts", tags, roles: ['PARENT'], request: { params: idParams, query: childInvoicesSchemas.query }, success: page(invoiceView.extend({ payments: z.array(paymentSummary) })), errors: ['NOT_FOUND'] });

  registry.register({ method: 'post', path: '/payments/offline', operationId: 'recordOfflinePayment', summary: 'Record cash, a bank transfer or a POS payment received at the school and issue a receipt. Send an Idempotency-Key header (16 to 64 characters). A bank reference can only be recorded once', tags, roles: PERMISSIONS['payments:offline'], request: { body: offlineBody }, success: { status: 201, description: 'Recorded', data: paymentView }, errors: ['NOT_FOUND', 'FEE_ALREADY_PAID', 'PAYMENT_AMOUNT_INVALID', 'CONFLICT'] });
  registry.register({ method: 'get', path: '/payments', operationId: 'listPayments', summary: 'Payments. Parents see their children\'s', tags, roles: PERMISSIONS['payments:read'], request: { query: listPaymentsQuery }, success: page(paymentView) });
  registry.register({ method: 'get', path: '/payments/{id}', operationId: 'getPayment', summary: 'One payment', tags, roles: PERMISSIONS['payments:read'], request: { params: idParams }, success: { status: 200, description: 'The payment', data: paymentView }, errors: ['NOT_FOUND'] });
  registry.register({ method: 'post', path: '/payments/{id}/reverse', operationId: 'reversePayment', summary: 'Undo a recorded offline payment with a reversing entry. A reason is required and audited', tags, roles: PERMISSIONS['payments:reverse'], request: { params: idParams, body: reverseBody }, success: { status: 200, description: 'Reversed', data: paymentView }, errors: ['NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'get', path: '/payments/{id}/receipt.pdf', operationId: 'getReceiptPdf', summary: 'The receipt as a PDF', tags, roles: PERMISSIONS['payments:read'], request: { params: idParams }, binaryResponse: 'application/pdf', success: { status: 200, description: 'The PDF', data: z.null() }, errors: ['NOT_FOUND', 'CONFLICT'] });

  registry.register({ method: 'get', path: '/fees/defaulters', operationId: 'listDefaulters', summary: 'Who owes money, biggest debt first, with totals per class. Overdue invoices only unless includeNotDue=true', tags, roles: PERMISSIONS['fees:defaulters'], request: { query: defaultersQuery }, success: { status: 200, description: 'The report', data: z.object({ summary: z.object({ students: num, outstandingKobo: num, byClassArm: z.array(z.object({ classArmId: z.string(), classArmName: z.string(), students: num, outstandingKobo: num })) }), rows: z.array(z.object({ studentId: z.string(), name: z.string(), admissionNo: z.string(), classArmId: z.string(), classArmName: z.string(), outstandingKobo: num, invoices: num, oldestDueDate: z.string(), parents: z.array(z.object({ parentId: z.string(), name: z.string(), phone: z.string().nullable() })) })) }), paginated: true } });
  registry.register({ method: 'post', path: '/fees/reminders', operationId: 'sendFeeReminders', summary: 'Remind parents of overdue invoices (in-app and email). At most one reminder per invoice every 3 days, 300 invoices per call', tags, roles: PERMISSIONS['fees:reminders'], request: { body: remindBody }, success: { status: 200, description: 'Result', data: z.object({ invoices: num, students: num, parentsNotified: num, studentsWithoutParents: num }) } });
}