import { z } from 'zod';
import { PERMISSIONS } from '../../config/constants';
import type { OpenApiRegistry } from '../../openapi/registry';
import { CONDUCT } from './reportCard.repository';

const objectId = z.string().regex(/^[a-f0-9]{24}$/);
const componentsInput = z.record(z.string(), z.number().min(0).max(100).nullable());

export const gridQuery = z.object({ classArmId: objectId, subjectId: objectId, termId: objectId });
export const gridSchemas = { query: gridQuery };

const saveGridBody = z.object({
  classArmId: objectId, subjectId: objectId, termId: objectId,
  entries: z.array(z.object({ studentId: objectId, components: componentsInput })).min(1).max(200),
});
export const saveGridSchemas = { body: saveGridBody };
export const submitSchemas = { body: z.object({ classArmId: objectId, subjectId: objectId, termId: objectId }) };

export const importQuerySchemas = { query: gridQuery };
const confirmBody = z.object({ importToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
export const confirmImportSchemas = { body: confirmBody };

const armTermParams = z.object({ classArmId: objectId, termId: objectId });
export const armTermSchemas = { params: armTermParams };

const reportEntries = z.object({ entries: z.array(z.object({ studentId: objectId, conduct: z.enum(CONDUCT).optional(), remark: z.string().trim().max(300).optional() })).min(1).max(200) });
export const saveReportCardsSchemas = { params: armTermParams, body: reportEntries };

const moderateBody = z.object({
  adjustments: z.array(z.object({ studentId: objectId, subjectId: objectId, components: componentsInput })).max(500).optional(),
  note: z.string().trim().max(500).optional(),
});
export const moderateSchemas = { params: armTermParams, body: moderateBody };
const unlockBody = z.object({ reason: z.string().trim().min(5).max(500) });
export const unlockSchemas = { params: armTermParams, body: unlockBody };

const idParams = z.object({ id: objectId });
export const studentResultsSchemas = { params: idParams, query: z.object({ termId: objectId.optional() }) };
export const reportCardPdfSchemas = { params: idParams, query: z.object({ termId: objectId }) };

const componentDef = z.object({ key: z.string(), name: z.string(), max: z.number() });
const stage = z.enum(['IN_PROGRESS', 'SUBMITTED', 'MODERATED', 'PUBLISHED']);
const att = z.object({ present: z.number().int(), absent: z.number().int(), late: z.number().int(), excused: z.number().int(), days: z.number().int(), rate: z.number().nullable() });

export function registerResultsOperations(registry: OpenApiRegistry): void {
  const tags = ['results'];
  const teacher = PERMISSIONS['scores:enter'];
  const done = (data: z.ZodType, description = 'Done') => ({ status: 200, description, data });
  const num = z.number().int();

  registry.register({ method: 'get', path: '/scores/grid', operationId: 'getScoreGrid', summary: 'The score grid for one class, subject and term, with each student\'s CA task average', tags, roles: teacher, request: { query: gridQuery }, success: done(z.object({ classArm: z.object({ id: z.string(), name: z.string() }), term: z.object({ id: z.string(), name: z.string() }), subject: z.object({ id: z.string(), name: z.string(), code: z.string() }), components: z.array(componentDef), caTaskCount: num, rows: z.array(z.object({ studentId: z.string(), studentName: z.string(), admissionNo: z.string(), components: z.record(z.string(), z.number().nullable()), total: z.number(), complete: z.boolean(), grade: z.string().nullable(), taskAverage: z.number().nullable(), tasksGraded: num, status: z.string().nullable(), editable: z.boolean() })) }), 'The grid'), errors: ['NOT_FOUND'] });
  registry.register({ method: 'put', path: '/scores/grid', operationId: 'saveScoreGrid', summary: 'Save scores. Leave a component out to keep it, send null to clear it. Locked results return RESULT_LOCKED', tags, roles: teacher, request: { body: saveGridBody }, success: done(z.object({ saved: num }), 'Saved'), errors: ['NOT_FOUND', 'CONFLICT', 'RESULT_LOCKED'] });
  registry.register({ method: 'post', path: '/scores/import', operationId: 'importScores', summary: 'Upload a CSV (field "file") with admissionNo and score columns. Returns a preview and every problem; saves nothing', tags, roles: teacher, request: { query: gridQuery }, upload: true, success: done(z.object({ rowCount: num, validCount: num, errors: z.array(z.object({ row: num, field: z.string(), issue: z.string() })), truncated: z.boolean(), preview: z.array(z.object({ admissionNo: z.string(), studentName: z.string(), components: z.record(z.string(), z.number().nullable()), total: z.number(), grade: z.string().nullable() })), importToken: z.string().nullable() }), 'Validation report'), errors: ['IMPORT_INVALID', 'NOT_FOUND'] });
  registry.register({ method: 'post', path: '/scores/import/confirm', operationId: 'confirmScoreImport', summary: 'Save a clean import', tags, roles: teacher, request: { body: confirmBody }, success: done(z.object({ saved: num }), 'Saved'), errors: ['IMPORT_TOKEN_EXPIRED', 'CONFLICT', 'RESULT_LOCKED'] });
  registry.register({ method: 'post', path: '/scores/submit', operationId: 'submitScores', summary: 'Submit a subject for moderation. Every student needs every component (enter 0 for an absentee)', tags, roles: teacher, request: { body: submitSchemas.body }, success: done(z.object({ submitted: num, alreadySubmitted: num }), 'Submitted'), errors: ['NOT_FOUND', 'CONFLICT', 'RESULT_LOCKED'] });

  registry.register({ method: 'get', path: '/report-cards/{classArmId}/{termId}', operationId: 'getReportCardSheet', summary: 'Class teacher: attendance, conduct, remarks, totals and positions for the class', tags, roles: PERMISSIONS['report-cards:compile'], request: { params: armTermParams }, success: done(z.object({ classArm: z.object({ id: z.string(), name: z.string() }), term: z.object({ id: z.string(), name: z.string() }), published: z.boolean(), locked: z.boolean(), students: z.array(z.object({ studentId: z.string(), name: z.string(), admissionNo: z.string(), attendance: att, conduct: z.enum(CONDUCT).nullable(), remark: z.string().nullable(), grandTotal: z.number(), average: z.number().nullable(), position: num })) }), 'The sheet'), errors: ['NOT_FOUND'] });
  registry.register({ method: 'put', path: '/report-cards/{classArmId}/{termId}', operationId: 'saveReportCards', summary: 'Class teacher: save conduct and remarks. Not allowed once results are locked', tags, roles: PERMISSIONS['report-cards:compile'], request: { params: armTermParams, body: reportEntries }, success: done(z.object({ saved: num }), 'Saved'), errors: ['NOT_FOUND', 'RESULT_LOCKED'] });

  registry.register({ method: 'get', path: '/results/{classArmId}/{termId}', operationId: 'getResultsSheet', summary: 'The class results sheet for moderation: students against subjects, with positions and each subject\'s stage', tags, roles: PERMISSIONS['results:sheet'], request: { params: armTermParams }, success: done(z.object({ classArm: z.object({ id: z.string(), name: z.string() }), term: z.object({ id: z.string(), name: z.string() }), stage, published: z.boolean(), locked: z.boolean(), subjects: z.array(z.object({ subjectId: z.string(), subjectName: z.string(), students: num, entered: num, stage: z.string() })), students: z.array(z.object({ studentId: z.string(), name: z.string(), admissionNo: z.string(), position: num, grandTotal: z.number(), average: z.number().nullable(), scores: z.array(z.object({ subjectId: z.string(), total: z.number().nullable(), grade: z.string().nullable(), status: z.string().nullable() })) })) }), 'The sheet'), errors: ['NOT_FOUND'] });
  registry.register({ method: 'post', path: '/results/{classArmId}/{termId}/moderate', operationId: 'moderateResults', summary: 'Moderate a class: optionally adjust scores, then move all submitted subjects to moderated. Every subject must be submitted', tags, roles: PERMISSIONS['results:moderate'], request: { params: armTermParams, body: moderateBody }, success: done(z.object({ moderated: num, adjusted: num }), 'Moderated'), errors: ['NOT_FOUND', 'CONFLICT', 'RESULT_LOCKED'] });
  registry.register({ method: 'post', path: '/results/{classArmId}/{termId}/publish', operationId: 'publishResults', summary: 'Publish a class\'s results. Locks them at once. Students and parents are notified', tags, roles: PERMISSIONS['results:publish'], request: { params: armTermParams }, success: done(z.object({ published: num, alreadyPublished: z.boolean() }), 'Published'), errors: ['NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'post', path: '/results/{classArmId}/{termId}/lock', operationId: 'lockResults', summary: 'Lock published results again after a correction', tags, roles: PERMISSIONS['results:lock'], request: { params: armTermParams }, success: done(z.object({ changed: num }), 'Locked'), errors: ['NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'post', path: '/results/{classArmId}/{termId}/unlock', operationId: 'unlockResults', summary: 'Open published results for correction. A reason is required and audited', tags, roles: PERMISSIONS['results:lock'], request: { params: armTermParams, body: unlockBody }, success: done(z.object({ changed: num }), 'Unlocked'), errors: ['NOT_FOUND', 'CONFLICT'] });

  registry.register({ method: 'get', path: '/students/{id}/results', operationId: 'getStudentResults', summary: 'Published scores, grades, positions and trend per term. Parents and students see published terms only', tags, roles: PERMISSIONS['results:read'], request: { params: idParams, query: studentResultsSchemas.query }, success: done(z.object({ terms: z.array(z.object({ termId: z.string(), termName: z.string(), sessionName: z.string(), classArmName: z.string(), published: z.boolean(), components: z.array(componentDef), subjects: z.array(z.object({ subjectId: z.string(), subjectName: z.string(), subjectCode: z.string(), components: z.record(z.string(), z.number().nullable()), total: z.number(), grade: z.string(), remark: z.string() })), grandTotal: z.number(), average: z.number().nullable(), position: num, classSize: num, reportCard: z.object({ available: z.boolean(), withheld: z.boolean() }) })), trend: z.array(z.object({ termId: z.string(), termName: z.string(), sessionName: z.string(), average: z.number().nullable(), position: num })) }), 'Results'), errors: ['NOT_FOUND'] });
  registry.register({ method: 'get', path: '/students/{id}/report-card.pdf', operationId: 'getReportCardPdf', summary: 'The report card as a PDF for a term. Published results only (admins can preview). Withheld cards return CONFLICT', tags, roles: PERMISSIONS['report-cards:read'], request: { params: idParams, query: reportCardPdfSchemas.query }, binaryResponse: 'application/pdf', success: { status: 200, description: 'The PDF', data: z.null() }, errors: ['NOT_FOUND', 'CONFLICT'] });
}