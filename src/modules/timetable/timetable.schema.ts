import { z } from 'zod';
import { PERMISSIONS, ROLES } from '../../config/constants';
import type { OpenApiRegistry } from '../../openapi/registry';

const objectId = z.string().regex(/^[a-f0-9]{24}$/);
const idParams = z.object({ classArmId: objectId });
const slotInput = z.object({ day: z.number().int().min(1).max(6), period: z.number().int().min(1).max(12), subjectId: objectId, teacherId: objectId });
const replaceBody = z.object({ slots: z.array(slotInput).max(80) });

export const timetableSchemas = { params: idParams };
export const replaceTimetableSchemas = { params: idParams, body: replaceBody };

const slotView = z.object({
  day: z.number().int(), period: z.number().int(), subjectId: z.string(), subjectName: z.string(),
  teacherId: z.string(), teacherName: z.string(),
});
const timetableView = z.object({ classArm: z.object({ id: z.string(), name: z.string() }), slots: z.array(slotView) });

export function registerTimetableOperations(registry: OpenApiRegistry): void {
  const tags = ['timetable'];
  registry.register({ method: 'get', path: '/timetable/{classArmId}', operationId: 'getTimetable', summary: 'A class timetable. Day 1 = Monday ... 6 = Saturday. Teachers, parents and students see only their own classes', tags, roles: PERMISSIONS['academics:read'], request: { params: idParams }, success: { status: 200, description: 'The timetable', data: timetableView }, errors: ['NOT_FOUND'] });
  registry.register({ method: 'put', path: '/timetable/{classArmId}', operationId: 'replaceTimetable', summary: 'Set the whole timetable of a class. Each teacher must teach that subject in that class and cannot be in two classes at once', tags, roles: PERMISSIONS['academics:write'], request: { params: idParams, body: replaceBody }, success: { status: 200, description: 'Saved', data: timetableView }, errors: ['NOT_FOUND'] });
  registry.register({ method: 'get', path: '/teacher/me/timetable', operationId: 'getMyTimetable', summary: "A teacher's own week across every class they teach", tags, roles: [ROLES.TEACHER], success: { status: 200, description: 'Lessons', data: z.array(slotView.extend({ classArmId: z.string(), classArmName: z.string() })) } });
}