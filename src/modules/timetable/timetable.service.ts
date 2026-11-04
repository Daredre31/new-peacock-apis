import { AppError, type ErrorDetail } from '../../common/errors/AppError';
import { isoWeekday, schoolToday } from '../../common/utils/dates';
import { ROLES, type Role } from '../../config/constants';
import { withTransaction } from '../../config/db';
import type { assignmentRepository } from '../academics/assignment.repository';
import type { sessionRepository } from '../academics/session.repository';
import type { structureRepository } from '../academics/structure.repository';
import { recordSafely, type AuditPort } from '../audit/audit.port';
import type { staffRepository } from '../users/staff.repository';
import type { SlotRecord, timetableRepository } from './timetable.repository';

interface Actor { id: string; role: Role }
interface Context { ip: string; requestId: string }
export interface SlotInput { day: number; period: number; subjectId: string; teacherId: string }

export function createTimetableService(deps: {
  repo: typeof timetableRepository;
  structure: Pick<typeof structureRepository, 'findArm' | 'findClass' | 'armsByIds' | 'classesByIds' | 'subjectsByIds'>;
  assignments: Pick<typeof assignmentRepository, 'holds'>;
  sessions: Pick<typeof sessionRepository, 'findCurrentSession'>;
  staff: Pick<typeof staffRepository, 'nameMap'>;
  armIdsOfUser: (actor: Actor) => Promise<string[]>;
  audit: AuditPort;
}) {
  const { repo, structure, assignments, sessions, staff, audit } = deps;

  async function armLabels(ids: string[]): Promise<Map<string, string>> {
    const arms = await structure.armsByIds(ids);
    const classes = await structure.classesByIds([...arms.values()].map((a) => a.classId));
    return new Map([...arms].map(([id, a]) => [id, `${classes.get(a.classId)?.name ?? ''} ${a.name}`.trim()]));
  }

  async function slotViews(slots: SlotRecord[]) {
    const [subjects, teachers, arms] = await Promise.all([
      structure.subjectsByIds(slots.map((s) => s.subjectId)),
      staff.nameMap(slots.map((s) => s.teacherId)),
      armLabels(slots.map((s) => s.classArmId)),
    ]);
    return slots.map((s) => ({
      classArmId: s.classArmId, classArmName: arms.get(s.classArmId) ?? '', day: s.day, period: s.period,
      subjectId: s.subjectId, subjectName: subjects.get(s.subjectId)?.name ?? '',
      teacherId: s.teacherId, teacherName: teachers.get(s.teacherId) ?? '',
    }));
  }

  return {
    /** Staff see any class. Teachers, parents and students see only their own classes. */
    async get(actor: Actor, armId: string) {
      const arm = await structure.findArm(armId);
      if (!arm) throw new AppError('NOT_FOUND');
      const staffRole = actor.role === ROLES.SUPER_ADMIN || actor.role === ROLES.ADMIN;
      if (!staffRole && !(await deps.armIdsOfUser(actor)).includes(armId)) throw new AppError('NOT_FOUND');

      const slots = await slotViews(await repo.forArm(armId));
      const name = (await armLabels([armId])).get(armId) ?? '';
      return { classArm: { id: armId, name }, slots: slots.map(({ classArmId: _a, classArmName: _n, ...rest }) => rest) };
    },

    /** The admin sets the whole class timetable in one go. Anything not in the list is removed. */
    async replace(actor: Actor, armId: string, input: { slots: SlotInput[] }, ctx: Context) {
      const arm = await structure.findArm(armId);
      if (!arm) throw new AppError('NOT_FOUND');
      const current = await sessions.findCurrentSession();
      if (!current) throw new AppError('VALIDATION_ERROR', { details: [{ field: 'slots', issue: 'There is no current session' }] });
      const parentClass = await structure.findClass(arm.classId);

      const details: ErrorDetail[] = [];
      const seen = new Set<string>();
      const holds = new Map<string, boolean>();

      for (const [i, slot] of input.slots.entries()) {
        const key = `${slot.day}|${slot.period}`;
        if (seen.has(key)) details.push({ field: `slots.${i}`, issue: 'Two lessons in the same period' });
        seen.add(key);

        if (!parentClass?.subjectIds.includes(slot.subjectId)) {
          details.push({ field: `slots.${i}.subjectId`, issue: 'This class does not offer that subject' });
          continue;
        }
        const pair = `${slot.teacherId}|${slot.subjectId}`;
        if (!holds.has(pair)) holds.set(pair, await assignments.holds(slot.teacherId, slot.subjectId, armId, current.id));
        if (!holds.get(pair)) details.push({ field: `slots.${i}.teacherId`, issue: 'This teacher does not teach this subject in this class' });
      }

      if (details.length === 0) {
        const clashes = await repo.conflictsFor(armId, input.slots.map((s) => ({ teacherId: s.teacherId, day: s.day, period: s.period })));
        const clash = new Set(clashes.map((c) => `${c.teacherId}|${c.day}|${c.period}`));
        input.slots.forEach((s, i) => {
          if (clash.has(`${s.teacherId}|${s.day}|${s.period}`)) details.push({ field: `slots.${i}.teacherId`, issue: 'This teacher is already teaching another class at that time' });
        });
      }
      if (details.length > 0) throw new AppError('VALIDATION_ERROR', { details: details.slice(0, 50) });

      await withTransaction((session) =>
        repo.replace(armId, input.slots.map((s) => ({ day: s.day, period: s.period, subjectId: s.subjectId, teacherId: s.teacherId })), session),
      );
      await recordSafely(audit, {
        action: 'TIMETABLE_REPLACED', actorId: actor.id, entityType: 'classArm', entityId: armId, ip: ctx.ip, requestId: ctx.requestId,
        metadata: { lessons: input.slots.length },
      });
      return this.get(actor, armId);
    },

    /** A teacher's own week, across every class they teach. */
    async forTeacher(actor: Actor) {
      const slots = await slotViews(await repo.forTeacher(actor.id));
      return slots.map(({ teacherId: _t, teacherName: _n, ...rest }) => rest);
    },

    /** Today's lessons for a class (used by the student dashboard). Empty on Sundays. */
    async todayForArm(armId: string) {
      const day = isoWeekday(schoolToday());
      if (day > 6) return [];
      const slots = await slotViews(await repo.forArmDay(armId, day));
      return slots.map(({ classArmId: _a, classArmName: _n, ...rest }) => rest);
    },

    /** Today's lessons for a teacher (used by the teacher dashboard). */
    async todayForTeacher(teacherId: string) {
      const day = isoWeekday(schoolToday());
      if (day > 6) return [];
      const slots = await slotViews(await repo.forTeacherDay(teacherId, day));
      return slots.map(({ teacherId: _t, teacherName: _n, ...rest }) => rest);
    },
  };
}

export type TimetableService = ReturnType<typeof createTimetableService>;