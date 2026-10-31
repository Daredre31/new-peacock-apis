import { z } from 'zod';
import { paginationShape } from '../../common/utils/pagination';
import { ALL_ROLES, ROLES } from '../../config/constants';
import type { OpenApiRegistry } from '../../openapi/registry';

const objectId = z.string().regex(/^[a-f0-9]{24}$/);
const idParams = z.object({ id: objectId });
export const idParamsSchemas = { params: idParams };
const q = z.string().trim().min(1).max(50).optional();

// ---- classes
const className = z.string().trim().min(2).max(40);
const level = z.number().int().min(1).max(30);
const subjectIds = z.array(objectId).max(60);

export const listClassesQuery = z.object({
  ...paginationShape,
  sort: z.enum(['level', '-level', 'name', '-name']).default('level'),
  q,
});
export const listClassesSchemas = { query: listClassesQuery };

const createClassBody = z.object({ name: className, level, subjectIds: subjectIds.optional() });
export const createClassSchemas = { body: createClassBody };

const updateClassBody = z.object({ name: className.optional(), level: level.optional(), subjectIds: subjectIds.optional() });
export const updateClassSchemas = { params: idParams, body: updateClassBody };

// ---- class arms
const armName = z.string().trim().min(1).max(20);

export const listArmsQuery = z.object({
  ...paginationShape,
  sort: z.enum(['name', '-name']).default('name'),
  classId: objectId.optional(),
  q,
});
export const listArmsSchemas = { query: listArmsQuery };

const createArmBody = z.object({ classId: objectId, name: armName });
export const createArmSchemas = { body: createArmBody };

const updateArmBody = z.object({ name: armName });
export const updateArmSchemas = { params: idParams, body: updateArmBody };

// ---- subjects
const subjectName = z.string().trim().min(2).max(60);
const subjectCode = z.string().trim().regex(/^[A-Za-z0-9]{2,10}$/, 'Use 2 to 10 letters or digits');

export const listSubjectsQuery = z.object({
  ...paginationShape,
  sort: z.enum(['name', '-name', 'code']).default('name'),
  q,
});
export const listSubjectsSchemas = { query: listSubjectsQuery };

const createSubjectBody = z.object({ name: subjectName, code: subjectCode });
export const createSubjectSchemas = { body: createSubjectBody };

const updateSubjectBody = z.object({ name: subjectName.optional(), code: subjectCode.optional() });
export const updateSubjectSchemas = { params: idParams, body: updateSubjectBody };

// ---- responses
const classView = z.object({ id: z.string(), name: z.string(), level: z.number().int(), subjectIds: z.array(z.string()) });
const armView = z.object({
  id: z.string(),
  classId: z.string(),
  className: z.string(),
  name: z.string(),
  displayName: z.string(),
  classTeacherId: z.string().nullable(),
});
const subjectView = z.object({ id: z.string(), name: z.string(), code: z.string() });

export function registerStructureOperations(registry: OpenApiRegistry): void {
  const tags = ['academics'];
  const write = [ROLES.ADMIN];
  const page = (data: z.ZodType, description: string) => ({ status: 200, description, data: z.array(data), paginated: true });

  registry.register({ method: 'get', path: '/classes', operationId: 'listClasses', summary: 'List classes, lowest level first', tags, roles: ALL_ROLES, request: { query: listClassesQuery }, success: page(classView, 'A page of classes') });
  registry.register({ method: 'post', path: '/classes', operationId: 'createClass', summary: 'Create a class and choose its subjects', tags, roles: write, request: { body: createClassBody }, success: { status: 201, description: 'Created', data: classView }, errors: ['CONFLICT'] });
  registry.register({ method: 'patch', path: '/classes/{id}', operationId: 'updateClass', summary: 'Change a class name, level or subject list', tags, roles: write, request: { params: idParams, body: updateClassBody }, success: { status: 200, description: 'Updated', data: classView }, errors: ['NOT_FOUND', 'CONFLICT'] });

  registry.register({ method: 'get', path: '/class-arms', operationId: 'listClassArms', summary: 'List class arms, optionally for one class', tags, roles: ALL_ROLES, request: { query: listArmsQuery }, success: page(armView, 'A page of class arms') });
  registry.register({ method: 'post', path: '/class-arms', operationId: 'createClassArm', summary: 'Create an arm, for example JSS1 A', tags, roles: write, request: { body: createArmBody }, success: { status: 201, description: 'Created', data: armView }, errors: ['CONFLICT'] });
  registry.register({ method: 'patch', path: '/class-arms/{id}', operationId: 'updateClassArm', summary: 'Rename an arm', tags, roles: write, request: { params: idParams, body: updateArmBody }, success: { status: 200, description: 'Updated', data: armView }, errors: ['NOT_FOUND', 'CONFLICT'] });

  registry.register({ method: 'get', path: '/subjects', operationId: 'listSubjects', summary: 'List subjects', tags, roles: ALL_ROLES, request: { query: listSubjectsQuery }, success: page(subjectView, 'A page of subjects') });
  registry.register({ method: 'post', path: '/subjects', operationId: 'createSubject', summary: 'Create a subject', tags, roles: write, request: { body: createSubjectBody }, success: { status: 201, description: 'Created', data: subjectView }, errors: ['CONFLICT'] });
  registry.register({ method: 'patch', path: '/subjects/{id}', operationId: 'updateSubject', summary: 'Change a subject name or code', tags, roles: write, request: { params: idParams, body: updateSubjectBody }, success: { status: 200, description: 'Updated', data: subjectView }, errors: ['NOT_FOUND', 'CONFLICT'] });
}