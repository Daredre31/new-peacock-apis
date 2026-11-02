import { z } from 'zod';
import { paginationShape } from '../../common/utils/pagination';
import { PERMISSIONS } from '../../config/constants';
import type { OpenApiRegistry } from '../../openapi/registry';
import { SUBMISSION_STATUS } from './task.repository';

const objectId = z.string().regex(/^[a-f0-9]{24}$/);
const idParams = z.object({ id: objectId });
const title = z.string().trim().min(3).max(150);
const instructions = z.string().trim().min(1).max(5000);
const maxScore = z.number().min(1).max(1000);
const iso = z.iso.datetime();

export const taskIdSchemas = { params: idParams };

export const listTasksQuery = z.object({
  ...paginationShape,
  teachingAssignmentId: objectId.optional(), classArmId: objectId.optional(), subjectId: objectId.optional(),
  from: iso.optional(), to: iso.optional(),
});
export const listTasksSchemas = { query: listTasksQuery };

const createBody = z.object({ teachingAssignmentId: objectId, title, instructions, dueAt: iso, maxScore, countsToCA: z.boolean().default(false) });
export const createTaskSchemas = { body: createBody };

const updateBody = z.object({ title: title.optional(), instructions: instructions.optional(), dueAt: iso.optional(), maxScore: maxScore.optional(), countsToCA: z.boolean().optional() });
export const updateTaskSchemas = { params: idParams, body: updateBody };

const gradeBody = z.object({ action: z.enum(['GRADE', 'RETURN']), score: z.number().min(0).max(1000).optional(), feedback: z.string().trim().min(1).max(2000).optional() });
export const gradeSchemas = { params: idParams, body: gradeBody };

const submitBody = z.object({ text: z.string().trim().min(1).max(10_000) });
export const submitSchemas = { params: idParams, body: submitBody };

export const myTasksQuery = z.object({ ...paginationShape });
export const myTasksSchemas = { query: myTasksQuery };
export const childTasksSchemas = { params: idParams, query: myTasksQuery };

const submissionStatus = z.enum([...Object.values(SUBMISSION_STATUS), 'PENDING', 'OVERDUE']);

const taskView = z.object({
  id: z.string(), teachingAssignmentId: z.string(), teacherId: z.string(), classArmId: z.string(), classArmName: z.string(),
  subjectId: z.string(), subjectName: z.string(), title: z.string(), instructions: z.string(),
  dueAt: iso, maxScore: z.number(), countsToCA: z.boolean(), createdAt: iso,
});
const studentTaskView = taskView.extend({
  status: submissionStatus, late: z.boolean().nullable(), submittedAt: iso.nullable(), score: z.number().nullable(),
  percent: z.number().nullable(), feedback: z.string().nullable(), submissionText: z.string().nullable(),
});
const submissionRow = z.object({
  submissionId: z.string().nullable(), studentId: z.string(), studentName: z.string(), status: submissionStatus,
  late: z.boolean().nullable(), submittedAt: iso.nullable(), text: z.string().nullable(), score: z.number().nullable(),
  percent: z.number().nullable(), feedback: z.string().nullable(),
});
const analyticsView = z.object({
  assigned: z.number().int(), submitted: z.number().int(), completionRate: z.number().nullable(), onTimeRate: z.number().nullable(), streak: z.number().int(),
  scoreTrend: z.array(z.object({ taskId: z.string(), title: z.string(), percent: z.number(), at: iso })),
  bySubject: z.array(z.object({ subjectId: z.string(), subjectName: z.string(), assigned: z.number().int(), submitted: z.number().int(), completionRate: z.number().nullable() })),
});

export function registerTaskOperations(registry: OpenApiRegistry): void {
  const tags = ['tasks'];
  const teacher = PERMISSIONS['tasks:write'];
  const page = (data: z.ZodType) => ({ status: 200, description: 'A page', data: z.array(data), paginated: true as const });

  registry.register({ method: 'get', path: '/tasks', operationId: 'listTasks', summary: 'Tasks. A teacher sees their own, an admin sees all', tags, roles: ['ADMIN', 'TEACHER'], request: { query: listTasksQuery }, success: page(taskView) });
  registry.register({ method: 'post', path: '/tasks', operationId: 'createTask', summary: 'Set a task for a subject you teach in a class (current session). The class is notified', tags, roles: teacher, request: { body: createBody }, success: { status: 201, description: 'Created', data: taskView }, errors: ['NOT_FOUND'] });
  registry.register({ method: 'get', path: '/tasks/{id}', operationId: 'getTask', summary: 'One task', tags, roles: ['ADMIN', 'TEACHER'], request: { params: idParams }, success: { status: 200, description: 'Found', data: taskView }, errors: ['NOT_FOUND'] });
  registry.register({ method: 'patch', path: '/tasks/{id}', operationId: 'updateTask', summary: 'Change a task. The maximum score cannot go below a score already given', tags, roles: teacher, request: { params: idParams, body: updateBody }, success: { status: 200, description: 'Updated', data: taskView }, errors: ['NOT_FOUND'] });
  registry.register({ method: 'delete', path: '/tasks/{id}', operationId: 'deleteTask', summary: 'Delete a task nobody has submitted to', tags, roles: teacher, request: { params: idParams }, success: { status: 200, description: 'Deleted', data: z.null() }, errors: ['NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'get', path: '/tasks/{id}/submissions', operationId: 'listTaskSubmissions', summary: 'Every student of the class with their submission status', tags, roles: teacher, request: { params: idParams }, success: { status: 200, description: 'Rows', data: z.array(submissionRow) }, errors: ['NOT_FOUND'] });
  registry.register({ method: 'patch', path: '/submissions/{id}/grade', operationId: 'gradeSubmission', summary: 'GRADE with a score, or RETURN with feedback for resubmission', tags, roles: teacher, request: { params: idParams, body: gradeBody }, success: { status: 200, description: 'Done', data: z.object({ submissionId: z.string(), status: submissionStatus, score: z.number().nullable(), percent: z.number().nullable(), feedback: z.string().nullable() }) }, errors: ['NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'get', path: '/student/me/tasks', operationId: 'listMyTasks', summary: 'My tasks this session with my status on each', tags, roles: PERMISSIONS['tasks:own'], request: { query: myTasksQuery }, success: page(studentTaskView) });
  registry.register({ method: 'get', path: '/student/me/tasks/analytics', operationId: 'getMyTaskAnalytics', summary: 'Completion rate, on-time rate, score trend and streak', tags, roles: PERMISSIONS['tasks:own'], success: { status: 200, description: 'Analytics', data: analyticsView } });
  registry.register({ method: 'post', path: '/tasks/{id}/submit', operationId: 'submitTask', summary: 'Submit or resubmit my answer. Late work is accepted and flagged. A graded task is final', tags, roles: PERMISSIONS['tasks:submit'], request: { params: idParams, body: submitBody }, success: { status: 201, description: 'Submitted', data: z.object({ submissionId: z.string(), status: submissionStatus, late: z.boolean(), submittedAt: iso }) }, errors: ['NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'get', path: '/children/{id}/tasks', operationId: 'listChildTasks', summary: "A linked child's tasks and deadlines (read-only, without their answers)", tags, roles: PERMISSIONS['children:read'], request: { params: idParams, query: myTasksQuery }, success: page(studentTaskView), errors: ['NOT_FOUND'] });
}