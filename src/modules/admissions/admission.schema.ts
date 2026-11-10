import { z } from 'zod';
import { paginationShape } from '../../common/utils/pagination';
import { PERMISSIONS } from '../../config/constants';
import type { OpenApiRegistry } from '../../openapi/registry';
import { ADMISSION_STATUS, type AdmissionStatus } from './application.repository';

const objectId = z.string().regex(/^[a-f0-9]{24}$/);
const idParams = z.object({ id: objectId });
const num = z.number().int();
const iso = z.iso.datetime();
const name = z.string().trim().min(1).max(60);
const statuses = Object.values(ADMISSION_STATUS) as [AdmissionStatus, ...AdmissionStatus[]];
const RELATIONSHIPS = ['FATHER', 'MOTHER', 'GUARDIAN', 'OTHER'] as const;

// ---- public
const applyBody = z.object({
  childFirstName: name, childMiddleName: name.optional(), childLastName: name,
  gender: z.enum(['MALE', 'FEMALE']), dateOfBirth: z.iso.date(), classId: objectId,
  previousSchool: z.string().trim().min(1).max(120).optional(), address: z.string().trim().min(1).max(200).optional(),
  parentFirstName: name, parentLastName: name, parentEmail: z.string().trim().min(3).max(254), parentPhone: z.string().trim().min(7).max(30),
  relationship: z.enum(RELATIONSHIPS),
  /** A hidden field on the form. Real people leave it empty. */
  website: z.string().max(200).optional(),
});
export const applySchemas = { body: applyBody };
const identify = z.object({ applicationNo: z.string().trim().min(6).max(30), contact: z.string().trim().min(3).max(254) });
export const identifySchemas = { body: identify };
export const photoSchemas = { body: identify };

// ---- staff
export const listApplicationsSchemas = { query: z.object({ ...paginationShape, status: z.enum(statuses).optional(), q: z.string().trim().min(1).max(60).optional() }) };
export const applicationIdSchemas = { params: idParams };
const acceptBody = z.object({ classArmId: objectId, sessionId: objectId.optional() });
export const acceptSchemas = { params: idParams, body: acceptBody };
const declineBody = z.object({ reason: z.string().trim().min(3).max(300) });
export const declineSchemas = { params: idParams, body: declineBody };
const settingsBody = z.object({ open: z.boolean().optional(), feeKobo: z.number().int().min(10_000).max(5_000_000).optional() });
export const updateSettingsSchemas = { body: settingsBody };

const publicView = z.object({
  applicationNo: z.string(), status: z.enum(statuses), childName: z.string(), className: z.string(), feeKobo: num, paid: z.boolean(), photoUploaded: z.boolean(),
  canUploadPhoto: z.boolean(), declineReason: z.string().nullable(), checkoutUrl: z.string().nullable(), createdAt: iso,
});
const adminView = z.object({
  id: z.string(), applicationNo: z.string(), status: z.enum(statuses),
  child: z.object({ firstName: z.string(), middleName: z.string().nullable(), lastName: z.string(), gender: z.enum(['MALE', 'FEMALE']), dateOfBirth: z.string(), classId: z.string(), className: z.string(), previousSchool: z.string().nullable(), address: z.string().nullable() }),
  parent: z.object({ firstName: z.string(), lastName: z.string(), email: z.string(), phone: z.string(), relationship: z.enum(RELATIONSHIPS), address: z.string().nullable() }),
  feeKobo: num, paid: z.boolean(), paidAt: iso.nullable(), photoUrl: z.string().nullable(), declineReason: z.string().nullable(), decidedAt: iso.nullable(),
  studentId: z.string().nullable(), parentUserId: z.string().nullable(), createdAt: iso,
  payments: z.array(z.object({ reference: z.string(), amountKobo: num, status: z.enum(['PENDING', 'SUCCESS', 'FAILED']), paidAt: iso.nullable(), createdAt: iso })),
});
const settingsView = z.object({ open: z.boolean(), feeKobo: num });

export function registerAdmissionOperations(registry: OpenApiRegistry): void {
  const pub = ['public admissions'];
  const staff = ['admissions'];
  registry.register({ method: 'get', path: '/public/admissions/info', operationId: 'getAdmissionInfo', summary: 'No login. Is admission open, what is the application fee (kobo), and which classes can be chosen', tags: pub, success: { status: 200, description: 'Info', data: z.object({ open: z.boolean(), feeKobo: num, classes: z.array(z.object({ id: z.string(), name: z.string() })) }) } });
  registry.register({ method: 'post', path: '/public/admissions', operationId: 'applyForAdmission', summary: 'No login. Saves the application and starts the Paystack payment of the application fee. Send the parent to checkoutUrl. If checkoutUrl is null, show message and let them use /public/admissions/pay later', tags: pub, request: { body: applyBody }, success: { status: 201, description: 'Saved', data: z.object({ applicationNo: z.string(), status: z.enum(statuses), feeKobo: num, checkoutUrl: z.string().nullable(), message: z.string().nullable() }) }, errors: ['VALIDATION_ERROR', 'CONFLICT', 'RATE_LIMITED'] });
  registry.register({ method: 'post', path: '/public/admissions/pay', operationId: 'payAdmissionFee', summary: 'No login. Starts the fee payment again for an unpaid application. Needs the application number and the parent email or phone', tags: pub, request: { body: identify }, success: { status: 200, description: 'Checkout', data: z.object({ applicationNo: z.string(), feeKobo: num, checkoutUrl: z.string() }) }, errors: ['NOT_FOUND', 'CONFLICT', 'SERVICE_UNAVAILABLE', 'RATE_LIMITED'] });
  registry.register({ method: 'post', path: '/public/admissions/status', operationId: 'getAdmissionStatus', summary: 'No login. Where is my application? Needs the application number and the parent email or phone. Also confirms a payment made just now. Call it on the page Paystack returns to', tags: pub, request: { body: identify }, success: { status: 200, description: 'Status', data: publicView }, errors: ['NOT_FOUND', 'RATE_LIMITED'] });
  registry.register({ method: 'post', path: '/public/admissions/photo', operationId: 'uploadAdmissionPhoto', summary: 'No login. multipart/form-data with the text fields applicationNo and contact (same as /public/admissions/status) and the file field "file" (JPEG, PNG or WebP, max 2 MB). Allowed once the fee is paid and until the school decides', tags: pub, upload: true, success: { status: 200, description: 'Status', data: publicView }, errors: ['NOT_FOUND', 'CONFLICT', 'VALIDATION_ERROR', 'RATE_LIMITED'] });

  registry.register({ method: 'get', path: '/admissions', operationId: 'listAdmissions', summary: 'Applications, newest paid first. Filter by status. Unpaid ones disappear by themselves after 14 days', tags: staff, roles: PERMISSIONS['admissions:read'], request: { query: listApplicationsSchemas.query }, success: { status: 200, description: 'A page', data: z.array(adminView), paginated: true as const } });
  registry.register({ method: 'get', path: '/admissions/settings', operationId: 'getAdmissionSettings', summary: 'Admission open or closed, and the application fee in kobo', tags: staff, roles: PERMISSIONS['admissions:read'], success: { status: 200, description: 'Settings', data: settingsView } });
  registry.register({ method: 'put', path: '/admissions/settings', operationId: 'updateAdmissionSettings', summary: 'Super admin: open or close admission, change the fee (N100 to N50,000). Applications already made keep the fee they were created with', tags: staff, roles: PERMISSIONS['admissions:settings'], request: { body: settingsBody }, success: { status: 200, description: 'Updated', data: settingsView } });
  registry.register({ method: 'get', path: '/admissions/{id}', operationId: 'getAdmission', summary: 'One application, with the photo URL and payment history', tags: staff, roles: PERMISSIONS['admissions:read'], request: { params: idParams }, success: { status: 200, description: 'The application', data: adminView }, errors: ['NOT_FOUND'] });
  registry.register({ method: 'post', path: '/admissions/{id}/accept', operationId: 'acceptAdmission', summary: 'Creates the student (in the chosen class arm, current session unless sessionId is sent) and the parent account, links them, and makes the photo the passport. The result shows the student temporary password once. Safe to run again if it stopped half way', tags: staff, roles: PERMISSIONS['admissions:review'], request: { params: idParams, body: acceptBody }, success: { status: 200, description: 'Accepted', data: z.object({ studentId: z.string(), admissionNo: z.string().nullable(), studentTemporaryPassword: z.string().nullable(), parentUserId: z.string(), parentAlreadyExisted: z.boolean(), parentTemporaryPassword: z.string().nullable(), passport: z.enum(['SET', 'FAILED', 'NONE']), note: z.string().nullable() }) }, errors: ['NOT_FOUND', 'CONFLICT', 'VALIDATION_ERROR'] });
  registry.register({ method: 'post', path: '/admissions/{id}/decline', operationId: 'declineAdmission', summary: 'Declines a paid application and emails the parent the reason. The fee is not refunded here', tags: staff, roles: PERMISSIONS['admissions:review'], request: { params: idParams, body: declineBody }, success: { status: 200, description: 'Declined', data: adminView }, errors: ['NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'post', path: '/admissions/{id}/recheck-payment', operationId: 'recheckAdmissionPayment', summary: 'When a parent says they paid but it does not show: asks Paystack now', tags: staff, roles: PERMISSIONS['admissions:review'], request: { params: idParams }, success: { status: 200, description: 'Result', data: z.object({ application: adminView, outcomes: z.array(z.string()) }) }, errors: ['NOT_FOUND'] });
}
