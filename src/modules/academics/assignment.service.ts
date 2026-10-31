import { AppError } from '../../common/errors/AppError';
import { isDuplicateKeyError } from '../../common/utils/mongoErrors';
import { recordSafely, type AuditPort } from '../audit/audit.port';
import { STAFF_TYPES } from '../users/staff.model';
import type { staffRepository } from '../users/staff.repository';
import type { AssignmentRecord, assignmentRepository } from './assignment.repository';
import type { sessionRepository } from './session.repository';
import type { structureRepository } from './structure.repository';
import type { TeacherArmsCache } from './teacherArms';

interface Actor { id: string }
interface Context { ip: string; requestId: string }

export interface AssignmentServiceDeps {
  assignments: typeof assignmentRepository;
  staff: Pick<typeof staffRepository, 'findByUserId' | 'nameMap'>;
  structure: Pick<typeof structureRepository, 'findArm' | 'findClass' | 'armsByIds' | 'classesByIds' | 'subjectsByIds' | 'setClassTeacher'>;
  sessions: Pick<typeof sessionRepository, 'findSession' | 'findCurrentSession'>;
  cache: Pick<TeacherArmsCache, 'invalidate'>;
  audit: AuditPort;
}

const fail = (field: string, issue: string): AppError =>
  new AppError('VALIDATION_ERROR', { details: [{ field, issue }] });

export function createAssignmentService(deps: AssignmentServiceDeps) {
  const { assignments, staff, structure, sessions, cache, audit } = deps;

  const log = (event: string, actor: Actor, ctx: Context, id: string, metadata: Record<string, unknown>) =>
    recordSafely(audit, { action: event, actorId: actor.id, entityType: 'teachingAssignment', entityId: id, ip: ctx.ip, requestId: ctx.requestId, metadata });

  async function assertTeacher(teacherId: string): Promise<void> {
    const found = await staff.findByUserId(teacherId);
    if (!found || found.type !== STAFF_TYPES.TEACHER) throw fail('teacherId', 'Teacher not found');
  }

  async function viewsOf(records: AssignmentRecord[]) {
    const [names, subjects, arms] = await Promise.all([
      staff.nameMap(records.map((r) => r.teacherId)),
      structure.subjectsByIds(records.map((r) => r.subjectId)),
      structure.armsByIds(records.map((r) => r.classArmId)),
    ]);
    const classes = await structure.classesByIds([...arms.values()].map((a) => a.classId));
    return records.map((r) => {
      const arm = arms.get(r.classArmId);
      const subject = subjects.get(r.subjectId);
      return {
        id: r.id,
        teacherId: r.teacherId,
        teacherName: names.get(r.teacherId) ?? '',
        subjectId: r.subjectId,
        subjectName: subject?.name ?? '',
        subjectCode: subject?.code ?? '',
        classArmId: r.classArmId,
        classArmName: arm ? `${classes.get(arm.classId)?.name ?? ''} ${arm.name}`.trim() : '',
        sessionId: r.sessionId,
        createdAt: r.createdAt.toISOString(),
      };
    });
  }
  const viewOf = async (record: AssignmentRecord) => {
    const [view] = await viewsOf([record]);
    if (!view) throw new Error('Assignment view could not be built');
    return view;
  };

  return {
    async list(input: { page: number; limit: number; sort: 'createdAt' | '-createdAt'; teacherId?: string | undefined; classArmId?: string | undefined; subjectId?: string | undefined; sessionId?: string | undefined }) {
      const { page, limit, sort, ...filter } = input;
      const { items, total } = await assignments.list(filter, { page, limit, sort });
      return { items: await viewsOf(items), total };
    },

    async create(input: { teacherId: string; subjectId: string; classArmId: string; sessionId?: string | undefined }, actor: Actor, ctx: Context) {
      await assertTeacher(input.teacherId);

      const arm = await structure.findArm(input.classArmId);
      if (!arm) throw fail('classArmId', 'Class arm not found');
      const parentClass = await structure.findClass(arm.classId);
      if (!parentClass?.subjectIds.includes(input.subjectId)) {
        throw fail('subjectId', 'This class does not offer that subject. Add it to the class first');
      }

      const session = input.sessionId ? await sessions.findSession(input.sessionId) : await sessions.findCurrentSession();
      if (!session) throw fail('sessionId', input.sessionId ? 'Session not found' : 'There is no current session');

      let created: AssignmentRecord;
      try {
        created = await assignments.create({ teacherId: input.teacherId, subjectId: input.subjectId, classArmId: arm.id, sessionId: session.id });
      } catch (err) {
        if (isDuplicateKeyError(err)) throw new AppError('CONFLICT', { message: 'This teacher already has this subject in this class arm', cause: err });
        throw err;
      }

      await cache.invalidate(input.teacherId);
      await log('TEACHING_ASSIGNMENT_CREATED', actor, ctx, created.id, { ...input });
      return viewOf(created);
    },

    /** Hands an assignment to another teacher. */
    async reassign(id: string, teacherId: string, actor: Actor, ctx: Context) {
      const existing = await assignments.findById(id);
      if (!existing) throw new AppError('NOT_FOUND');
      await assertTeacher(teacherId);

      let updated: AssignmentRecord | null;
      try {
        updated = await assignments.changeTeacher(id, teacherId);
      } catch (err) {
        if (isDuplicateKeyError(err)) throw new AppError('CONFLICT', { message: 'That teacher already has this subject in this class arm', cause: err });
        throw err;
      }
      if (!updated) throw new AppError('NOT_FOUND');

      await Promise.all([cache.invalidate(existing.teacherId), cache.invalidate(teacherId)]);
      await log('TEACHING_ASSIGNMENT_REASSIGNED', actor, ctx, id, { from: existing.teacherId, to: teacherId });
      return viewOf(updated);
    },

    async remove(id: string, actor: Actor, ctx: Context): Promise<void> {
      const removed = await assignments.remove(id);
      if (!removed) throw new AppError('NOT_FOUND');
      await cache.invalidate(removed.teacherId);
      await log('TEACHING_ASSIGNMENT_DELETED', actor, ctx, id, { teacherId: removed.teacherId });
    },

    /** Every arm has exactly one class teacher. Setting one replaces the previous. */
    async setClassTeacher(armId: string, teacherId: string, actor: Actor, ctx: Context) {
      const arm = await structure.findArm(armId);
      if (!arm) throw new AppError('NOT_FOUND');
      await assertTeacher(teacherId);

      const updated = await structure.setClassTeacher(armId, teacherId);
      if (!updated) throw new AppError('NOT_FOUND');

      await Promise.all([teacherId, ...(arm.classTeacherId ? [arm.classTeacherId] : [])].map((id) => cache.invalidate(id)));
      await recordSafely(audit, {
        action: 'CLASS_TEACHER_SET', actorId: actor.id, entityType: 'classArm', entityId: armId, ip: ctx.ip, requestId: ctx.requestId,
        before: { classTeacherId: arm.classTeacherId }, after: { classTeacherId: teacherId },
      });

      const names = await staff.nameMap([teacherId]);
      return { classArmId: armId, classTeacherId: teacherId, classTeacherName: names.get(teacherId) ?? '' };
    },
  };
}

export type AssignmentService = ReturnType<typeof createAssignmentService>;