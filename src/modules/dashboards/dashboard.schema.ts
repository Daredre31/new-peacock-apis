import { z } from 'zod';
import { PERMISSIONS, ROLES } from '../../config/constants';
import type { OpenApiRegistry } from '../../openapi/registry';

const objectId = z.string().regex(/^[a-f0-9]{24}$/);
export const rosterSchemas = { params: z.object({ classArmId: objectId }) };

const iso = z.iso.datetime();
const num = z.number().int();
const rate = z.number().nullable();
const idName = z.object({ id: z.string(), name: z.string() });
const attendanceSummary = z.object({ present: num, absent: num, late: num, excused: num, days: num, rate });
const requestItem = z.object({ id: z.string(), reference: z.string(), type: z.string(), title: z.string(), status: z.string(), updatedAt: iso });
const fees = z.record(z.string(), z.unknown()).nullable();

const statsShape = {
  generatedAt: iso, date: z.string(), term: idName.nullable(),
  counts: z.object({ students: num, teachers: num, admins: num, staff: num, parents: num }),
  staffToday: z.object({ total: num, present: num, late: num, onLeave: num, absent: num, notMarked: num, available: num }),
  attendanceToday: z.object({ marked: num, present: num, late: num, excused: num, absent: num, rate, classesTotal: num, classesMarked: num }),
  unmarkedClasses: z.array(idName),
  lowAttendance: z.array(z.object({ studentId: z.string(), name: z.string(), admissionNo: z.string(), rate: z.number(), days: num, absent: num })),
};
const taskRow = z.object({ taskId: z.string(), title: z.string(), subjectName: z.string(), classArmName: z.string(), dueAt: iso, submitted: num, awaitingMarking: num });
const lesson = z.object({ day: num, period: num, subjectId: z.string(), subjectName: z.string() }).passthrough();
const nextTask = z.object({ taskId: z.string(), title: z.string(), subjectName: z.string(), dueAt: z.string() }).passthrough();

const superAdminView = z.object({ ...statsShape, pendingDecisions: z.object({ total: num, items: z.array(requestItem) }), fees });
const adminView = z.object({
  ...statsShape,
  pending: z.object({
    requests: z.object({ total: num, items: z.array(requestItem) }),
    exams: z.object({ total: num, items: z.array(z.object({ id: z.string(), title: z.string(), type: z.string(), windowStart: iso })) }),
    announcements: z.object({ total: num, items: z.array(z.object({ id: z.string(), title: z.string(), createdAt: iso })) }),
    parentLinks: z.object({ total: num }),
  }),
  collection: fees,
});
const teacherView = z.object({
  generatedAt: iso, date: z.string(), weekday: z.string(), session: idName.nullable(), term: idName.nullable(), classes: num, subjects: num,
  pendingMarking: z.object({ total: num, tasks: z.array(taskRow) }), deadlines: z.array(taskRow),
  exams: z.array(z.object({ id: z.string(), title: z.string(), type: z.string(), windowStart: iso, windowEnd: iso })),
  lowAttendance: z.array(z.object({ studentId: z.string(), name: z.string(), rate: z.number(), days: num })),
  lowScores: z.array(z.object({ studentId: z.string(), name: z.string(), averagePercent: z.number(), tasksGraded: num })),
  todayLessons: z.array(lesson), notifications: z.object({ unread: num }),
});
const studentView = z.object({
  generatedAt: iso, date: z.string(), weekday: z.string(), classArm: idName.nullable(), todayLessons: z.array(lesson),
  tasks: z.object({ pending: num, overdue: num, next: z.array(nextTask) }),
  exams: z.array(z.object({ id: z.string(), title: z.string(), subjectName: z.string(), windowStart: iso, windowEnd: iso, state: z.string() })),
  attendance: attendanceSummary.nullable(), announcements: z.object({ unread: num }), notifications: z.object({ unread: num }),
});
const parentView = z.object({
  generatedAt: iso,
  children: z.array(z.object({
    id: z.string(), name: z.string(), admissionNo: z.string(), classArmName: z.string().nullable(), attendance: attendanceSummary.nullable(),
    tasks: z.object({ pending: num, overdue: num, next: z.array(nextTask) }),
    nextExam: z.object({ examId: z.string(), title: z.string(), subjectName: z.string(), windowStart: iso, windowEnd: iso }).nullable(),
  })),
  announcements: z.object({ unread: num }), notifications: z.object({ unread: num }), fees,
});
const classesView = z.array(z.object({
  classArmId: z.string(), classArmName: z.string(), isClassTeacher: z.boolean(), studentCount: num,
  subjects: z.array(z.object({ id: z.string(), name: z.string(), code: z.string() })),
}));
const rosterView = z.object({
  classArm: idName,
  students: z.array(z.object({
    studentId: z.string(), name: z.string(), admissionNo: z.string(), attendance: attendanceSummary,
    parents: z.array(z.object({ parentId: z.string(), name: z.string(), relationship: z.string(), phone: z.string().nullable(), email: z.string().nullable() })),
  })),
});

export function registerDashboardOperations(registry: OpenApiRegistry): void {
  const tags = ['dashboards'];
  const one = (path: string, operationId: string, summary: string, permission: keyof typeof PERMISSIONS, data: z.ZodType) =>
    registry.register({ method: 'get', path, operationId, summary, tags, roles: PERMISSIONS[permission], success: { status: 200, description: 'The dashboard', data } });

  one('/super-admin/dashboard', 'getSuperAdminDashboard', 'Counts, staff availability, attendance today, low attendance and pending decisions. fees is null until Phase 4', 'dashboard:super-admin', superAdminView);
  one('/admin/dashboard', 'getAdminDashboard', 'Operational view with no revenue totals: counts, attendance, unmarked classes, and what waits for approval', 'dashboard:admin', adminView);
  one('/teacher/dashboard', 'getTeacherDashboard', "Today's lessons, work waiting for marking, deadlines, exams, and students with low attendance or low task scores", 'dashboard:teacher', teacherView);
  one('/student/dashboard', 'getStudentDashboard', "Today's timetable, pending tasks, upcoming exams, unread announcements and attendance", 'dashboard:student', studentView);
  one('/parent/dashboard', 'getParentDashboard', 'Family overview: one block per linked child', 'dashboard:parent', parentView);
  one('/teacher/me/classes', 'getMyClasses', 'Classes and subjects I teach this session, with student counts', 'teacher-classes:read', classesView);
  registry.register({ method: 'get', path: '/teacher/me/classes/{classArmId}/roster', operationId: 'getClassRoster', summary: "The class teacher's roster: attendance rate this term and parent contact details. Class teacher only", tags, roles: [ROLES.TEACHER], request: { params: rosterSchemas.params }, success: { status: 200, description: 'The roster', data: rosterView }, errors: ['NOT_FOUND'] });
}