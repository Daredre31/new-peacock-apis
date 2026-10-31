import { z } from 'zod';
import { paginationShape } from '../../common/utils/pagination';
import { PERMISSIONS } from '../../config/constants';
import type { OpenApiRegistry } from '../../openapi/registry';

const objectId = z.string().regex(/^[a-f0-9]{24}$/);
const idParams = z.object({ id: objectId });

export const listAssignmentsQuery = z.object({
  ...paginationShape,
  sort: z.enum(['-createdAt', 'createdAt']).default('-createdAt'),
  teacherId: objectId.optional(),
  classArmId: objectId.optional(),
  subjectId: objectId.optional(),
  sessionId: objectId.optional(),
});
export const listAssignmentsSchemas = { query: listAssignmentsQuery };

const createBody = z.object({ teacherId: objectId, subjectId: objectId, classArmId: objectId, sessionId: objectId.optional() });
export const createAssignmentSchemas = { body: createBody };

const reassignBody = z.object({ teacherId: objectId });
export const reassignSchemas = { params: idParams, body: reassignBody };
export const assignmentIdSchemas = { params: idParams };

const classTeacherBody = z.object({ teacherId: objectId });
export const classTeacherSchemas = { params: idParams, body: classTeacherBody };

const assignmentView = z.object({
  id: z.string(), teacherId: z.string(), teacherName: z.string(), subjectId: z.string(), subjectName: z.string(),
  subjectCode: z.string(), classArmId: z.string(), classArmName: z.string(), sessionId: z.string(), createdAt: z.iso.datetime(),
});

export function registerAssignmentOperations(registry: OpenApiRegistry): void {
  const tags = ['academics'];
  const write = PERMISSIONS['teaching-assignments:write'];

  registry.register({ method: 'get', path: '/teaching-assignments', operationId: 'listTeachingAssignments', summary: 'List assignments. A teacher sees only their own', tags, roles: PERMISSIONS['teaching-assignments:read'], request: { query: listAssignmentsQuery }, success: { status: 200, description: 'A page', data: z.array(assignmentView), paginated: true } });
  registry.register({ method: 'post', path: '/teaching-assignments', operationId: 'createTeachingAssignment', summary: 'Give a teacher a subject in a class arm. The class must offer the subject. Defaults to the current session', tags, roles: write, request: { body: createBody }, success: { status: 201, description: 'Created', data: assignmentView }, errors: ['CONFLICT'] });
  registry.register({ method: 'patch', path: '/teaching-assignments/{id}', operationId: 'reassignTeachingAssignment', summary: 'Hand an assignment to another teacher', tags, roles: write, request: { params: idParams, body: reassignBody }, success: { status: 200, description: 'Updated', data: assignmentView }, errors: ['NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'delete', path: '/teaching-assignments/{id}', operationId: 'deleteTeachingAssignment', summary: 'Remove an assignment', tags, roles: write, request: { params: idParams }, success: { status: 200, description: 'Removed', data: z.null() }, errors: ['NOT_FOUND'] });
  registry.register({ method: 'put', path: '/class-arms/{id}/class-teacher', operationId: 'setClassTeacher', summary: 'Set the class teacher of an arm. Replaces the previous one', tags, roles: PERMISSIONS['academics:write'], request: { params: idParams, body: classTeacherBody }, success: { status: 200, description: 'Set', data: z.object({ classArmId: z.string(), classTeacherId: z.string(), classTeacherName: z.string() }) }, errors: ['NOT_FOUND'] });
}