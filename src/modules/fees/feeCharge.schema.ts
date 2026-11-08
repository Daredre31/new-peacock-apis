import { z } from 'zod';
import { MAX_KOBO } from '../../common/utils/money';
import { paginationShape } from '../../common/utils/pagination';
import { PERMISSIONS } from '../../config/constants';
import type { OpenApiRegistry } from '../../openapi/registry';
import { FEE_CHARGE_STATUS, type FeeChargeStatus } from './feeCharge.repository';

const objectId = z.string().regex(/^[a-f0-9]{24}$/);
const idParams = z.object({ id: objectId });
const iso = z.iso.datetime();
const num = z.number().int();
const kobo = z.number().int().min(1).max(MAX_KOBO);
const chargeStatus = Object.values(FEE_CHARGE_STATUS) as [FeeChargeStatus, ...FeeChargeStatus[]];
const item = z.object({ name: z.string().trim().min(1).max(60), amountKobo: kobo });
const items = z.array(item).min(1).max(30);
const title = z.string().trim().min(3).max(100);

const audience = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('CLASS'), classId: objectId }),
  z.object({ kind: z.literal('ARM'), classArmId: objectId }),
  z.object({ kind: z.literal('STUDENTS'), studentIds: z.array(objectId).min(1).max(200) }),
]);

export const listFeeChargesQuery = z.object({ ...paginationShape, termId: objectId.optional(), status: z.enum(chargeStatus).optional() });
export const listFeeChargesSchemas = { query: listFeeChargesQuery };
const createBody = z.object({
  termId: objectId, title, items, dueDate: z.iso.date(), audience,
  /** Set true only if an unpaid charge should hold back report cards when the school withholds reports for owing. */
  blocksReports: z.boolean().default(false),
});
export const createFeeChargeSchemas = { body: createBody };
const updateBody = z.object({ title: title.optional(), items: items.optional(), dueDate: z.iso.date().optional(), audience: audience.optional(), blocksReports: z.boolean().optional() });
export const updateFeeChargeSchemas = { params: idParams, body: updateBody };
export const feeChargeIdSchemas = { params: idParams };

const chargeView = z.object({
  id: z.string(), title: z.string(), termId: z.string(), termName: z.string(), items: z.array(item), totalKobo: num, dueDate: z.string(), blocksReports: z.boolean(),
  audience: z.object({ kind: z.enum(['CLASS', 'ARM', 'STUDENTS']), classId: z.string().nullable(), classArmId: z.string().nullable(), studentIds: z.array(z.string()), label: z.string() }),
  status: z.enum(chargeStatus), approvedAt: iso.nullable(), issuedAt: iso.nullable(), invoicesIssued: num, createdAt: iso,
});

export function registerFeeChargeOperations(registry: OpenApiRegistry): void {
  const tags = ['fee charges'];
  const page = (data: z.ZodType) => ({ status: 200, description: 'A page', data: z.array(data), paginated: true as const });
  registry.register({ method: 'get', path: '/fee-charges', operationId: 'listFeeCharges', summary: 'Extra charges added during a term (trips, levies, replacements). Amounts are in kobo', tags, roles: PERMISSIONS['fee-charges:read'], request: { query: listFeeChargesQuery }, success: page(chargeView) });
  registry.register({ method: 'post', path: '/fee-charges', operationId: 'createFeeCharge', summary: 'Draft an extra charge for a class, one arm, or chosen students. It needs super admin approval before it can be issued. It never changes the term fee structure or existing invoices', tags, roles: PERMISSIONS['fee-charges:write'], request: { body: createBody }, success: { status: 201, description: 'Created', data: chargeView }, errors: ['VALIDATION_ERROR', 'CONFLICT'] });
  registry.register({ method: 'get', path: '/fee-charges/{id}', operationId: 'getFeeCharge', summary: 'One extra charge', tags, roles: PERMISSIONS['fee-charges:read'], request: { params: idParams }, success: { status: 200, description: 'The charge', data: chargeView }, errors: ['NOT_FOUND'] });
  registry.register({ method: 'patch', path: '/fee-charges/{id}', operationId: 'updateFeeCharge', summary: 'Change a draft. An approved charge is frozen', tags, roles: PERMISSIONS['fee-charges:write'], request: { params: idParams, body: updateBody }, success: { status: 200, description: 'Updated', data: chargeView }, errors: ['NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'delete', path: '/fee-charges/{id}', operationId: 'deleteFeeCharge', summary: 'Delete a draft', tags, roles: PERMISSIONS['fee-charges:write'], request: { params: idParams }, success: { status: 200, description: 'Deleted', data: z.null() }, errors: ['NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'post', path: '/fee-charges/{id}/approve', operationId: 'approveFeeCharge', summary: 'The super admin approves a charge so it can be issued', tags, roles: PERMISSIONS['fee-charges:approve'], request: { params: idParams }, success: { status: 200, description: 'Approved', data: chargeView }, errors: ['NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'post', path: '/fee-charges/{id}/revoke-approval', operationId: 'revokeFeeChargeApproval', summary: 'Reopen an approved charge, only while nothing has been issued from it', tags, roles: PERMISSIONS['fee-charges:approve'], request: { params: idParams }, success: { status: 200, description: 'Reopened', data: chargeView }, errors: ['NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'post', path: '/fee-charges/{id}/issue', operationId: 'issueFeeCharge', summary: 'Create the invoices for an approved charge. Safe to repeat: students who already have it are skipped. Students not enrolled this session are counted in notEnrolled', tags, roles: PERMISSIONS['fee-charges:issue'], request: { params: idParams }, success: { status: 200, description: 'Result', data: z.object({ students: num, created: num, skipped: num, failed: num, notEnrolled: num, totalKobo: num }) }, errors: ['NOT_FOUND', 'CONFLICT'] });
}
