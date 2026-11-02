import { z } from 'zod';
import { paginationShape } from '../../common/utils/pagination';
import { PERMISSIONS, ROLES } from '../../config/constants';
import type { OpenApiRegistry } from '../../openapi/registry';
import { ATTENDANCE_STATUSES, STAFF_ATTENDANCE_STATUSES } from './attendance.repository';

const objectId = z.string().regex(/^[a-f0-9]{24}$/);
const idParams = z.object({ id: objectId });
const date = z.iso.date();
const studentStatus = z.enum(ATTENDANCE_STATUSES);
const staffStatus = z.enum(STAFF_ATTENDANCE_STATUSES);

export const markClassSchemas = {
  params: idParams,
  body: z.object({ date, entries: z.array(z.object({ studentId: objectId, status: studentStatus })).min(1).max(200) }),
};

export const listAttendanceQuery = z.object({
  ...paginationShape,
  classArmId: objectId.optional(), studentId: objectId.optional(),
  date: date.optional(), from: date.optional(), to: date.optional(), status: studentStatus.optional(),
});
export const listAttendanceSchemas = { query: listAttendanceQuery };

export const studentAttendanceQuery = z.object({ ...paginationShape, from: date.optional(), to: date.optional() });
export const studentAttendanceSchemas = { params: idParams, query: studentAttendanceQuery };

const noticeBody = z.object({ studentId: objectId, fromDate: date, toDate: date, reason: z.string().trim().min(3).max(500) });
export const createNoticeSchemas = { body: noticeBody };

export const listNoticesQuery = z.object({ ...paginationShape, studentId: objectId.optional(), from: date.optional(), to: date.optional() });
export const listNoticesSchemas = { query: listNoticesQuery };

export const markStaffSchemas = {
  body: z.object({ date, entries: z.array(z.object({ staffId: objectId, status: staffStatus })).min(1).max(500) }),
};

export const listStaffQuery = z.object({
  ...paginationShape,
  staffId: objectId.optional(), date: date.optional(), from: date.optional(), to: date.optional(), status: staffStatus.optional(),
});
export const listStaffAttendanceSchemas = { query: listStaffQuery };

const attendanceRow = z.object({ id: z.string(), studentId: z.string(), studentName: z.string(), classArmId: z.string(), date, status: studentStatus, markedBy: z.string() });
const noticeView = z.object({ id: z.string(), studentId: z.string(), studentName: z.string(), parentId: z.string(), fromDate: date, toDate: date, reason: z.string(), createdAt: z.iso.datetime() });
const staffRow = z.object({ id: z.string(), staffId: z.string(), staffName: z.string(), date, status: staffStatus, markedBy: z.string() });

export function registerAttendanceOperations(registry: OpenApiRegistry): void {
  const tags = ['attendance'];
  const page = (data: z.ZodType) => ({ status: 200, description: 'A page', data: z.array(data), paginated: true as const });

  registry.register({ method: 'put', path: '/attendance/class-arms/{id}', operationId: 'markClassAttendance', summary: "Mark a day's attendance for a class arm. The class teacher (last 14 days) or an admin. Absences covered by a notice become EXCUSED", tags, roles: PERMISSIONS['attendance:mark'], request: markClassSchemas, success: { status: 200, description: 'Saved', data: z.object({ classArmId: z.string(), date, saved: z.number().int(), present: z.number().int(), absent: z.number().int(), late: z.number().int(), excused: z.number().int() }) }, errors: ['NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'get', path: '/attendance', operationId: 'listAttendance', summary: 'Attendance records. Teachers see only their classes', tags, roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.TEACHER], request: { query: listAttendanceQuery }, success: page(attendanceRow) });
  registry.register({ method: 'get', path: '/students/{id}/attendance', operationId: 'getStudentAttendance', summary: "One student's attendance with totals (parents: own children, students: themselves)", tags, roles: PERMISSIONS['attendance:read'], request: { params: idParams, query: studentAttendanceQuery }, success: { status: 200, description: 'Summary and a page of records', data: z.object({ summary: z.object({ PRESENT: z.number().int(), ABSENT: z.number().int(), LATE: z.number().int(), EXCUSED: z.number().int(), days: z.number().int(), rate: z.number().nullable() }), records: z.array(attendanceRow) }), paginated: true }, errors: ['NOT_FOUND'] });
  registry.register({ method: 'post', path: '/absence-notices', operationId: 'createAbsenceNotice', summary: 'A parent reports a child absent for some days. Marks existing absences as excused', tags, roles: PERMISSIONS['absence-notices:create'], request: { body: noticeBody }, success: { status: 201, description: 'Recorded', data: noticeView }, errors: ['NOT_FOUND'] });
  registry.register({ method: 'get', path: '/absence-notices', operationId: 'listAbsenceNotices', summary: 'Absence notices. Teachers see only their classes', tags, roles: PERMISSIONS['absence-notices:read'], request: { query: listNoticesQuery }, success: page(noticeView) });
  registry.register({ method: 'put', path: '/staff-attendance', operationId: 'markStaffAttendance', summary: 'Mark staff attendance for a day', tags, roles: PERMISSIONS['staff-attendance:write'], request: markStaffSchemas, success: { status: 200, description: 'Saved', data: z.object({ date, saved: z.number().int() }) } });
  registry.register({ method: 'get', path: '/staff-attendance', operationId: 'listStaffAttendance', summary: 'Staff attendance. Teachers see only their own', tags, roles: PERMISSIONS['staff-attendance:read'], request: { query: listStaffQuery }, success: page(staffRow) });
}