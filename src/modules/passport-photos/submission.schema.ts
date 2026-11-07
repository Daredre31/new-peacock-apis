import { z } from 'zod';
import { paginationShape } from '../../common/utils/pagination';
import { PERMISSIONS } from '../../config/constants';
import type { OpenApiRegistry } from '../../openapi/registry';
import { SUBMISSION_STATUS, UPLOADER_ROLES } from './submission.model';

const objectId = z.string().regex(/^[a-f0-9]{24}$/);
const statusValues = Object.values(SUBMISSION_STATUS) as [string, ...string[]];

const studentParams = z.object({ id: objectId });
const decisionParams = z.object({ studentId: objectId });

export const studentPhotoSchemas = { params: studentParams };
export const decisionSchemas = { params: decisionParams };
export const rejectSchemas = { params: decisionParams, body: z.object({ reason: z.string().trim().min(3).max(300) }).strict() };
export const bulkApproveSchemas = { body: z.object({ studentIds: z.array(objectId).min(1).max(50) }).strict() };
export const listQueueSchemas = {
  query: z.object({ status: z.enum(statusValues).default(SUBMISSION_STATUS.PENDING), ...paginationShape }),
};

const submissionView = z.object({
  studentId: z.string(),
  status: z.enum(['NONE', ...statusValues] as [string, ...string[]]),
  photoUrl: z.url().nullable(),
  reason: z.string().nullable(),
  uploaderRole: z.enum(UPLOADER_ROLES).nullable(),
  submittedAt: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  passportUrl: z.url().nullable(),
});
const queueItem = submissionView.extend({ name: z.string(), admissionNo: z.string() });
const bulkResult = z.object({ studentId: z.string(), ok: z.boolean(), code: z.string().optional() });

export function registerPassportPhotoOperations(registry: OpenApiRegistry): void {
  const tags = ['passport photos'];
  const review = PERMISSIONS['passport-photos:review'];

  registry.register({ method: 'put', path: '/students/{id}/passport-photo', operationId: 'submitPassportPhoto', summary: 'A student (for themselves) or a linked parent proposes a passport photo (field "file", JPEG, PNG or WebP, max 2 MB). It waits for admin approval and replaces any earlier proposal. The current passport stays until it is approved', tags, roles: PERMISSIONS['passport-photos:submit'], request: { params: studentParams }, upload: true, success: { status: 200, description: 'Waiting for approval', data: submissionView }, errors: ['NOT_FOUND', 'SERVICE_UNAVAILABLE'] });
  registry.register({ method: 'get', path: '/students/{id}/passport-photo', operationId: 'getPassportPhoto', summary: 'Status of the proposed photo (status NONE when nothing was proposed) and the current approved passport', tags, roles: PERMISSIONS['passport-photos:read'], request: { params: studentParams }, success: { status: 200, description: 'Found', data: submissionView }, errors: ['NOT_FOUND'] });
  registry.register({ method: 'get', path: '/passport-photos', operationId: 'listPassportPhotos', summary: 'Admin queue of proposed photos, oldest first. Default status PENDING', tags, roles: review, request: { query: listQueueSchemas.query }, success: { status: 200, description: 'A page', data: z.array(queueItem), paginated: true } });
  registry.register({ method: 'post', path: '/passport-photos/approve-bulk', operationId: 'approvePassportPhotosBulk', summary: 'Approve up to 50 photos at once. One failure does not stop the others', tags, roles: review, request: { body: bulkApproveSchemas.body }, success: { status: 200, description: 'One result per student', data: z.array(bulkResult) } });
  registry.register({ method: 'post', path: '/passport-photos/{studentId}/approve', operationId: 'approvePassportPhoto', summary: 'Approve: the proposed photo becomes the student passport and the student and parents are notified', tags, roles: review, request: { params: decisionParams }, success: { status: 200, description: 'Approved', data: submissionView }, errors: ['NOT_FOUND', 'CONFLICT', 'SERVICE_UNAVAILABLE'] });
  registry.register({ method: 'post', path: '/passport-photos/{studentId}/reject', operationId: 'rejectPassportPhoto', summary: 'Reject with a reason (3 to 300 characters). The photo is deleted and the family can upload another', tags, roles: review, request: { params: decisionParams, body: rejectSchemas.body }, success: { status: 200, description: 'Rejected', data: submissionView }, errors: ['NOT_FOUND', 'CONFLICT'] });
}
