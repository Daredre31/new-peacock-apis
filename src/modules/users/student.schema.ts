import { z } from 'zod';
import { paginationShape } from '../../common/utils/pagination';
import { PERMISSIONS, ROLES } from '../../config/constants';
import type { OpenApiRegistry } from '../../openapi/registry';
import { GENDERS } from './staff.model';
import { STUDENT_STATUS, type StudentStatus } from './student.model';

const objectId = z.string().regex(/^[a-f0-9]{24}$/);
const idParams = z.object({ id: objectId });
const name = z.string().trim().min(1).max(60);
const statusValues = Object.values(STUDENT_STATUS) as [StudentStatus, ...StudentStatus[]];

export const studentIdSchemas = { params: idParams };

export const listStudentsQuery = z.object({
  ...paginationShape,
  sort: z.enum(['name', '-name', 'admissionNo', 'createdAt', '-createdAt']).default('name'),
  q: z.string().trim().min(1).max(50).optional(),
  status: z.enum(statusValues).optional(),
  classArmId: objectId.optional(),
});
export const listStudentsSchemas = { query: listStudentsQuery };

const createBody = z.object({
  firstName: name,
  lastName: name,
  gender: z.enum(GENDERS).optional(),
  dateOfBirth: z.iso.date().optional(),
  address: z.string().trim().min(1).max(200).optional(),
  email: z.string().trim().min(3).max(254).optional(),
  phone: z.string().trim().min(7).max(30).optional(),
  /** Defaults to the current session. */
  admissionSessionId: objectId.optional(),
  /** Optional: puts the student in this class for the admission session. */
  classArmId: objectId.optional(),
  delivery: z.enum(['TEMPORARY_PASSWORD', 'EMAIL_INVITE']).default('TEMPORARY_PASSWORD'),
});
export const createStudentSchemas = { body: createBody };

const updateBody = z.object({
  firstName: name.optional(),
  lastName: name.optional(),
  gender: z.enum(GENDERS).optional(),
  dateOfBirth: z.iso.date().optional(),
  address: z.string().trim().min(1).max(200).optional(),
  email: z.string().trim().min(3).max(254).optional(),
  phone: z.string().trim().min(7).max(30).optional(),
  status: z.enum(statusValues).optional(),
});
export const updateStudentSchemas = { params: idParams, body: updateBody };

const enrolBody = z.object({ classArmId: objectId, sessionId: objectId.optional() });
export const enrolStudentSchemas = { params: idParams, body: enrolBody };

const confirmBody = z.object({ importToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
export const confirmImportSchemas = { body: confirmBody };

const studentView = z.object({
  id: z.string(),
  admissionNo: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  gender: z.enum(GENDERS).nullable(),
  dateOfBirth: z.iso.date().nullable(),
  address: z.string().nullable(),
  status: z.enum(statusValues),
  admissionSessionId: z.string(),
  enrolment: z.object({ sessionId: z.string(), classArmId: z.string(), classArmName: z.string() }).nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  mustChangePassword: z.boolean(),
  lastLoginAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

const importReport = z.object({
  rowCount: z.number().int(),
  validCount: z.number().int(),
  errors: z.array(z.object({ row: z.number().int(), field: z.string(), issue: z.string() })),
  truncated: z.boolean(),
  /** Only present when the file is completely clean. Valid for 15 minutes. */
  importToken: z.string().nullable(),
});

const importResult = z.object({
  created: z.array(z.object({ row: z.number().int(), id: z.string(), admissionNo: z.string(), name: z.string(), temporaryPassword: z.string() })),
  failed: z.array(z.object({ row: z.number().int(), reason: z.string() })),
});

export function registerStudentOperations(registry: OpenApiRegistry): void {
  const tags = ['students'];
  const writeRoles = PERMISSIONS['students:write'];

  registry.register({ method: 'get', path: '/students', operationId: 'listStudents', summary: 'List students. Teachers see only the classes they teach', tags, roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.TEACHER], request: { query: listStudentsQuery }, success: { status: 200, description: 'A page', data: z.array(studentView), paginated: true } });
  registry.register({ method: 'post', path: '/students', operationId: 'createStudent', summary: 'Admit a student. Returns the registration number and a one-time temporary password', tags, roles: writeRoles, request: { body: createBody }, success: { status: 201, description: 'Created', data: z.object({ account: studentView, temporaryPassword: z.string().nullable(), inviteEmailSent: z.boolean().nullable() }) }, errors: ['CONFLICT'] });
  registry.register({ method: 'get', path: '/students/{id}', operationId: 'getStudent', summary: 'One student (a parent sees only their children, a student only themselves)', tags, roles: PERMISSIONS['students:read'], request: { params: idParams }, success: { status: 200, description: 'Found', data: studentView }, errors: ['NOT_FOUND'] });
  registry.register({ method: 'patch', path: '/students/{id}', operationId: 'updateStudent', summary: 'Update a student', tags, roles: writeRoles, request: { params: idParams, body: updateBody }, success: { status: 200, description: 'Updated', data: studentView }, errors: ['NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'delete', path: '/students/{id}', operationId: 'deleteStudent', summary: 'Remove a student (soft delete). Ends all their logins', tags, roles: writeRoles, request: { params: idParams }, success: { status: 200, description: 'Removed', data: z.null() }, errors: ['NOT_FOUND'] });
  registry.register({ method: 'put', path: '/students/{id}/enrolment', operationId: 'enrolStudent', summary: 'Put a student in a class for a session (defaults to the current one)', tags, roles: writeRoles, request: { params: idParams, body: enrolBody }, success: { status: 200, description: 'Enrolled', data: studentView }, errors: ['NOT_FOUND'] });
  registry.register({ method: 'post', path: '/students/import', operationId: 'importStudents', summary: 'Upload a CSV (field "file", max 2 MB, 1000 rows). Validates every row and returns a report; nothing is saved', tags, roles: PERMISSIONS['students:import'], upload: true, success: { status: 200, description: 'Validation report', data: importReport }, errors: ['IMPORT_INVALID'] });
  registry.register({ method: 'post', path: '/students/import/confirm', operationId: 'confirmStudentImport', summary: 'Save a clean import. Returns each new registration number and one-time password', tags, roles: PERMISSIONS['students:import'], request: { body: confirmBody }, success: { status: 200, description: 'Import result', data: importResult }, errors: ['IMPORT_TOKEN_EXPIRED'] });
}