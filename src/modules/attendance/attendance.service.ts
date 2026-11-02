import { AppError, type ErrorDetail } from '../../common/errors/AppError';
import type { ScopeService } from '../../common/scope/scope.service';
import { daysBetween, eachDate, isIsoDate, isWeekday, schoolToday } from '../../common/utils/dates';
import { logger } from '../../common/utils/logger';
import { sanitizeText } from '../../common/utils/text';
import { ROLES, type Role } from '../../config/constants';
import type { enrolmentRepository } from '../academics/enrolment.repository';
import type { sessionRepository } from '../academics/session.repository';
import type { structureRepository } from '../academics/structure.repository';
import type { TeacherArmsCache } from '../academics/teacherArms';
import { recordSafely, type AuditPort } from '../audit/audit.port';
import type { NotificationService } from '../notifications/notification.service';
import type { RequestEvents } from '../requests/request.events';
import type { staffRepository } from '../users/staff.repository';
import type { studentRepository } from '../users/student.repository';
import type { AttendanceFilter, AttendanceStatus, StaffAttendanceStatus, attendanceRepository } from './attendance.repository';

interface Actor { id: string; role: Role }
interface Context { ip: string; requestId: string }

const TEACHER_BACKDATE_DAYS = 14;
const STAFF_BACKDATE_DAYS = 90;
const MAX_NOTICE_DAYS = 30;

export interface AttendanceServiceDeps {
  repo: typeof attendanceRepository;
  scope: Pick<ScopeService, 'assertCanAccessStudent' | 'assertCanMarkAttendance'>;
  enrolments: Pick<typeof enrolmentRepository, 'forStudents' | 'studentIdsInArms'>;
  sessions: Pick<typeof sessionRepository, 'findTermByDate' | 'findCurrentSession'>;
  structure: Pick<typeof structureRepository, 'findArm'>;
  students: Pick<typeof studentRepository, 'nameMap'>;
  staff: Pick<typeof staffRepository, 'nameMap' | 'activeUserIds'>;
  teacherArms: Pick<TeacherArmsCache, 'armIdsOf'>;
  notifier: Pick<NotificationService, 'notify'>;
  events: RequestEvents;
  audit: AuditPort;
}

const fail = (field: string, issue: string): AppError => new AppError('VALIDATION_ERROR', { details: [{ field, issue }] });

/** A real calendar date, not in the future, and not older than `maxBack` days (null means no limit). */
function assertSchoolDate(field: string, date: string, maxBack: number | null): void {
  if (!isIsoDate(date)) throw fail(field, 'Use the format YYYY-MM-DD');
  const today = schoolToday();
  if (date > today) throw fail(field, 'Cannot be in the future');
  if (maxBack !== null && daysBetween(date, today) > maxBack) {
    throw fail(field, `Only the last ${maxBack} days can be changed here. Ask an admin`);
  }
}

export function createAttendanceService(deps: AttendanceServiceDeps) {
  const { repo, scope, enrolments, sessions, structure, students, staff, teacherArms, notifier, audit } = deps;

  const log = (action: string, actor: Actor, ctx: Context, entityType: string, entityId: string | undefined, metadata: Record<string, unknown>) =>
    recordSafely(audit, { action, actorId: actor.id, entityType, ...(entityId ? { entityId } : {}), ip: ctx.ip, requestId: ctx.requestId, metadata });

  // Approved leave puts the person on leave on every working day of it.
  deps.events.onDecided(async (event) => {
    if (event.type !== 'LEAVE' || event.outcome !== 'APPROVED') return;
    const { startDate, endDate } = event.payload;
    if (typeof startDate !== 'string' || typeof endDate !== 'string') return;
    const dates = eachDate(startDate, endDate, 200).filter(isWeekday);
    await repo.upsertStaffAttendance(dates.map((date) => ({ staffId: event.createdBy, date, status: 'ON_LEAVE' as const })), event.decidedBy);
    logger.info({ requestId: event.requestId, days: dates.length }, 'staff leave recorded');
  });

  async function studentRows(items: Awaited<ReturnType<typeof repo.listAttendance>>['items']) {
    const names = await students.nameMap(items.map((i) => i.studentId));
    return items.map((i) => ({ ...i, studentName: names.get(i.studentId) ?? '' }));
  }

  return {
    /** The class teacher marks their own class. An admin can mark any class. */
    async markClassDay(actor: Actor, armId: string, input: { date: string; entries: { studentId: string; status: AttendanceStatus }[] }, ctx: Context) {
      if (!(await structure.findArm(armId))) throw new AppError('NOT_FOUND');
      await scope.assertCanMarkAttendance(actor, armId);
      assertSchoolDate('date', input.date, actor.role === ROLES.TEACHER ? TEACHER_BACKDATE_DAYS : null);

      const term = await sessions.findTermByDate(input.date);
      if (!term) throw fail('date', 'This date is not inside any term');
      if (term.locked) throw new AppError('CONFLICT', { message: 'This term is closed' });

      const enrolled = new Set(await enrolments.studentIdsInArms([armId], term.sessionId));
      const seen = new Set<string>();
      const details: ErrorDetail[] = [];
      input.entries.forEach((entry, i) => {
        if (seen.has(entry.studentId)) details.push({ field: `entries.${i}.studentId`, issue: 'Listed twice' });
        seen.add(entry.studentId);
        if (!enrolled.has(entry.studentId)) details.push({ field: `entries.${i}.studentId`, issue: 'Not enrolled in this class arm' });
      });
      if (details.length > 0) throw new AppError('VALIDATION_ERROR', { details: details.slice(0, 50) });

      // A parent's absence notice turns an absence into an excused one.
      const excused = new Set(await repo.noticesCovering(input.entries.filter((e) => e.status === 'ABSENT').map((e) => e.studentId), input.date));
      const rows = input.entries.map((e) => ({
        studentId: e.studentId, classArmId: armId, date: input.date,
        status: e.status === 'ABSENT' && excused.has(e.studentId) ? ('EXCUSED' as const) : e.status,
      }));
      await repo.upsertAttendance(rows, actor.id);

      const count = (status: AttendanceStatus) => rows.filter((r) => r.status === status).length;
      const result = { classArmId: armId, date: input.date, saved: rows.length, present: count('PRESENT'), absent: count('ABSENT'), late: count('LATE'), excused: count('EXCUSED') };
      await log('ATTENDANCE_MARKED', actor, ctx, 'classArm', armId, result);
      return result;
    },

    /** Teachers see only their classes. Admins and the super admin see everything. */
    async list(actor: Actor, input: { page: number; limit: number; classArmId?: string | undefined; studentId?: string | undefined; date?: string | undefined; from?: string | undefined; to?: string | undefined; status?: AttendanceStatus | undefined }) {
      const filter: AttendanceFilter = { studentId: input.studentId, date: input.date, from: input.from, to: input.to, status: input.status };

      if (actor.role === ROLES.TEACHER) {
        const own = await teacherArms.armIdsOf(actor.id);
        filter.classArmIds = input.classArmId ? own.filter((id) => id === input.classArmId) : own;
        if (input.studentId) await scope.assertCanAccessStudent(actor, input.studentId);
      } else if (input.classArmId) {
        filter.classArmIds = [input.classArmId];
      }

      const { items, total } = await repo.listAttendance(filter, { page: input.page, limit: input.limit });
      return { items: await studentRows(items), total };
    },

    /** One student's record and totals. Parents see their children, students themselves, teachers their classes. */
    async forStudent(actor: Actor, studentId: string, input: { page: number; limit: number; from?: string | undefined; to?: string | undefined }) {
      await scope.assertCanAccessStudent(actor, studentId);
      const [{ items, total }, counts] = await Promise.all([
        repo.listAttendance({ studentId, from: input.from, to: input.to }, { page: input.page, limit: input.limit }),
        repo.summaryFor(studentId, input.from, input.to),
      ]);
      const attended = counts.PRESENT + counts.LATE + counts.EXCUSED;
      const days = attended + counts.ABSENT;
      return {
        total,
        data: {
          summary: { ...counts, days, rate: days === 0 ? null : Math.round((attended / days) * 1000) / 10 },
          records: await studentRows(items),
        },
      };
    },

    /** A parent tells the school a child will be, or was, absent. */
    async createNotice(actor: Actor, input: { studentId: string; fromDate: string; toDate: string; reason: string }, ctx: Context) {
      await scope.assertCanAccessStudent(actor, input.studentId); // only your own linked children
      if (!isIsoDate(input.fromDate)) throw fail('fromDate', 'Use the format YYYY-MM-DD');
      if (!isIsoDate(input.toDate)) throw fail('toDate', 'Use the format YYYY-MM-DD');
      if (input.toDate < input.fromDate) throw fail('toDate', 'Must not be before the first day');
      if (daysBetween(input.fromDate, input.toDate) + 1 > MAX_NOTICE_DAYS) throw fail('toDate', `A notice can cover at most ${MAX_NOTICE_DAYS} days`);
      const today = schoolToday();
      if (daysBetween(input.fromDate, today) > TEACHER_BACKDATE_DAYS) throw fail('fromDate', 'Too far in the past. Please contact the school');
      if (daysBetween(today, input.toDate) > 90) throw fail('toDate', 'Too far in the future');

      const notice = await repo.createNotice({ ...input, parentId: actor.id, reason: sanitizeText(input.reason) });
      const excused = await repo.markExcused(input.studentId, input.fromDate, input.toDate);

      // Tell the class teacher. A failure here never fails the notice.
      try {
        const current = await sessions.findCurrentSession();
        const enrolled = current ? (await enrolments.forStudents([input.studentId], current.id)).get(input.studentId) : undefined;
        const arm = enrolled ? await structure.findArm(enrolled.classArmId) : null;
        if (arm?.classTeacherId) {
          const name = (await students.nameMap([input.studentId])).get(input.studentId) ?? 'A student';
          await notifier.notify({
            userIds: [arm.classTeacherId], type: 'ABSENCE_NOTICE', title: 'Absence notice',
            body: `${name} will be absent from ${input.fromDate} to ${input.toDate}.`, data: { studentId: input.studentId }, email: false,
          });
        }
      } catch (err) {
        logger.warn({ err }, 'absence notice teacher notification failed');
      }

      await log('ABSENCE_NOTICE_CREATED', actor, ctx, 'student', input.studentId, { fromDate: input.fromDate, toDate: input.toDate, excusedExisting: excused });
      const names = await students.nameMap([notice.studentId]);
      return { ...notice, studentName: names.get(notice.studentId) ?? '', createdAt: notice.createdAt.toISOString() };
    },

    async listNotices(actor: Actor, input: { page: number; limit: number; studentId?: string | undefined; from?: string | undefined; to?: string | undefined }) {
      let studentIds: string[] | undefined;
      if (actor.role === ROLES.TEACHER) {
        const current = await sessions.findCurrentSession();
        const arms = await teacherArms.armIdsOf(actor.id);
        studentIds = current ? await enrolments.studentIdsInArms(arms, current.id) : [];
      }
      const { items, total } = await repo.listNotices({ studentIds, studentId: input.studentId, from: input.from, to: input.to }, { page: input.page, limit: input.limit });
      const names = await students.nameMap(items.map((n) => n.studentId));
      return { total, items: items.map((n) => ({ ...n, studentName: names.get(n.studentId) ?? '', createdAt: n.createdAt.toISOString() })) };
    },

    /** The admin marks staff for a day. */
    async markStaffDay(actor: Actor, input: { date: string; entries: { staffId: string; status: StaffAttendanceStatus }[] }, ctx: Context) {
      assertSchoolDate('date', input.date, STAFF_BACKDATE_DAYS);
      const ids = input.entries.map((e) => e.staffId);
      if (new Set(ids).size !== ids.length) throw fail('entries', 'A staff member is listed twice');

      const known = await staff.activeUserIds(ids);
      const details = input.entries.flatMap((e, i) => (known.has(e.staffId) ? [] : [{ field: `entries.${i}.staffId`, issue: 'Staff member not found' }]));
      if (details.length > 0) throw new AppError('VALIDATION_ERROR', { details: details.slice(0, 50) });

      await repo.upsertStaffAttendance(input.entries.map((e) => ({ ...e, date: input.date })), actor.id);
      const result = { date: input.date, saved: input.entries.length };
      await log('STAFF_ATTENDANCE_MARKED', actor, ctx, 'staffAttendance', undefined, result);
      return result;
    },

    /** A teacher sees only their own record. */
    async listStaff(actor: Actor, input: { page: number; limit: number; staffId?: string | undefined; date?: string | undefined; from?: string | undefined; to?: string | undefined; status?: StaffAttendanceStatus | undefined }) {
      const staffId = actor.role === ROLES.TEACHER ? actor.id : input.staffId;
      const { items, total } = await repo.listStaffAttendance({ ...input, staffId }, { page: input.page, limit: input.limit });
      const names = await staff.nameMap(items.map((i) => i.staffId));
      return { total, items: items.map((i) => ({ ...i, staffName: names.get(i.staffId) ?? '' })) };
    },
  };
}

export type AttendanceService = ReturnType<typeof createAttendanceService>;