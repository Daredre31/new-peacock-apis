import { z } from 'zod';
import { PERMISSIONS } from '../../config/constants';
import type { OpenApiRegistry } from '../../openapi/registry';
import { REPORT_FORMATS, REPORT_STATUS, REPORT_TYPES, type ReportStatus } from './report.repository';

const objectId = z.string().regex(/^[a-f0-9]{24}$/);
const statusValues = Object.values(REPORT_STATUS) as [ReportStatus, ...ReportStatus[]];

const typeParams = z.object({ type: z.enum(REPORT_TYPES) });
const createBody = z.object({
  format: z.enum(REPORT_FORMATS),
  /** ENROLMENT: sessionId (default current), classArmId. ATTENDANCE: from, to (at most 120 days), classArmId. TERM_RESULTS: classArmId, termId. */
  sessionId: objectId.optional(), termId: objectId.optional(), classArmId: objectId.optional(),
  from: z.iso.date().optional(), to: z.iso.date().optional(),
});
export const createReportSchemas = { params: typeParams, body: createBody };
export const reportIdSchemas = { params: z.object({ id: objectId }) };

const reportView = z.object({
  id: z.string(), type: z.enum(REPORT_TYPES), format: z.enum(REPORT_FORMATS), status: z.enum(statusValues), error: z.string().nullable(),
  fileName: z.string().nullable(), size: z.number().int().nullable(), rowCount: z.number().int().nullable(),
  createdAt: z.iso.datetime(), completedAt: z.iso.datetime().nullable(), expiresAt: z.iso.datetime(), downloadable: z.boolean(),
});

export function registerReportOperations(registry: OpenApiRegistry): void {
  const tags = ['reports'];
  const roles = PERMISSIONS['reports:generate'];
  registry.register({ method: 'post', path: '/reports/{type}', operationId: 'createReport', summary: 'Queue an export (CSV or PDF). Returns at once; poll GET /reports/{id} until status is READY. Financial reports arrive with fees', tags, roles, request: { params: typeParams, body: createBody }, success: { status: 202, description: 'Queued', data: reportView }, errors: ['CONFLICT', 'NOT_FOUND'] });
  registry.register({ method: 'get', path: '/reports/{id}', operationId: 'getReport', summary: 'Status of a report you requested (the super admin can see any)', tags, roles, request: reportIdSchemas, success: { status: 200, description: 'Status', data: reportView }, errors: ['NOT_FOUND'] });
  registry.register({ method: 'get', path: '/reports/{id}/download', operationId: 'downloadReport', summary: 'Download a finished report. Files are kept for 7 days', tags, roles, request: reportIdSchemas, binaryResponse: 'application/octet-stream', success: { status: 200, description: 'The file (CSV or PDF)', data: z.null() }, errors: ['NOT_FOUND', 'CONFLICT'] });
}