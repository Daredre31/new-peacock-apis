import { AppError } from '../../common/errors/AppError';
import { isDuplicateKeyError } from '../../common/utils/mongoErrors';
import type { Role } from '../../config/constants';
import { ROLES } from '../../config/constants';
import type { assignmentRepository } from '../academics/assignment.repository';
// import type { sessionRepository } from '../academics/session.repository';
import type { structureRepository } from '../academics/structure.repository';
import { recordSafely, type AuditPort } from '../audit/audit.port';
import type { NotificationService } from '../notifications/notification.service';
import type { AssessmentConfig } from '../settings/assessment';
import type { studentRepository } from '../users/student.repository';
import type { taskRepository } from '../tasks/task.repository';
import type { userRepository } from '../users/user.repository';
import type { ResultsContext } from './results.context';
import { totalOf, type Components } from './results.engine';
import { SCORE_STATUS, type ScoreWrite, type scoreRepository } from './score.repository';
import { planWrites, scoreKey, teacherCanEdit } from './scores.plan';
import { gradeFor } from '../settings/assessment';

interface Actor { id: string; role: Role }
interface Context { ip: string; requestId: string }
export interface GridQuery { classArmId: string; subjectId: string; termId: string }

export interface ScoresServiceDeps {
  ctx: ResultsContext;
  scores: typeof scoreRepository;
  settings: { getAssessment(): Promise<AssessmentConfig> };
  assignments: Pick<typeof assignmentRepository, 'holds'>;
  structure: Pick<typeof structureRepository, 'subjectsByIds'>;
  students: Pick<typeof studentRepository, 'profileMap'>;
  tasks: Pick<typeof taskRepository, 'caAverages'>;
  users: Pick<typeof userRepository, 'findIdsByRoles'>;
  notifier: Pick<NotificationService, 'notify'>;
  audit: AuditPort;
}

export async function writeScores(scores: Pick<typeof scoreRepository, 'saveMany'>, writes: ScoreWrite[], editedBy: string): Promise<void> {
  try {
    await scores.saveMany(writes, editedBy);
  } catch (err) {
    if (isDuplicateKeyError(err)) throw new AppError('CONFLICT', { message: 'Someone changed these scores while you were editing. Reload and try again.' });
    throw err;
  }
}

// const fail = (field: string, issue: string): AppError => new AppError('VALIDATION_ERROR', { details: [{ field, issue }] });

export function createScoresService(deps: ScoresServiceDeps) {
  const { ctx, scores, settings, assignments, structure, students, tasks, users, notifier, audit } = deps;

  /** Only a teacher who holds this subject in this class (this session) gets in. Anyone else sees "not found". */
  async function teacherContext(actor: Actor, q: GridQuery) {
    const base = await ctx.armTerm(q.classArmId, q.termId);
    if (!(await assignments.holds(actor.id, q.subjectId, q.classArmId, base.term.sessionId))) throw new AppError('NOT_FOUND');
    return base;
  }

  return {
    teacherContext,

    async grid(actor: Actor, q: GridQuery) {
      const base = await teacherContext(actor, q);
      const [config, docs, profiles, ca, subject] = await Promise.all([
        settings.getAssessment(), scores.forGrid(q.classArmId, q.subjectId, q.termId), students.profileMap(base.studentIds),
        tasks.caAverages(q.classArmId, q.subjectId, base.term.sessionId), structure.subjectsByIds([q.subjectId]),
      ]);
      const subjectInfo = subject.get(q.subjectId);
      if (!subjectInfo) throw new AppError('NOT_FOUND');

      const byStudent = new Map(docs.map((d) => [d.studentId, d]));
      const rows = base.studentIds
        .map((studentId) => {
          const doc = byStudent.get(studentId);
          const components: Components = Object.fromEntries(config.components.map((c) => [c.key, doc?.components[c.key] ?? null]));
          const { total, complete } = totalOf(components, config);
          const taskInfo = ca.byStudent.get(studentId);
          return {
            studentId, studentName: profiles.get(studentId)?.name ?? '', admissionNo: profiles.get(studentId)?.admissionNo ?? '',
            components, total, complete, grade: complete ? gradeFor(total, config.bands).grade : null,
            taskAverage: taskInfo?.average ?? null, tasksGraded: taskInfo?.graded ?? 0,
            status: doc?.status ?? null, editable: teacherCanEdit(doc) === 'OK',
          };
        })
        .sort((a, b) => a.studentName.localeCompare(b.studentName));

      return {
        classArm: { id: base.arm.id, name: base.arm.name }, term: { id: base.term.id, name: base.term.name },
        subject: { id: q.subjectId, name: subjectInfo.name, code: subjectInfo.code },
        components: config.components, caTaskCount: ca.taskCount, rows,
      };
    },

    /** Saves some or all component scores for some or all students. Leave a component out to keep it, send null to clear it. */
    async saveGrid(actor: Actor, input: GridQuery & { entries: { studentId: string; components: Record<string, number | null> }[] }, c: Context) {
      const base = await teacherContext(actor, input);
      const [config, docs] = await Promise.all([settings.getAssessment(), scores.forGrid(input.classArmId, input.subjectId, input.termId)]);

      const plan = planWrites({
        armId: input.classArmId, termId: input.termId,
        entries: input.entries.map((e) => ({ studentId: e.studentId, subjectId: input.subjectId, components: e.components })),
        existing: new Map(docs.map((d) => [scoreKey(d.studentId, d.subjectId), d])),
        enrolled: new Set(base.studentIds), config, canEdit: teacherCanEdit,
      });
      await writeScores(scores, plan.writes, actor.id);

      await recordSafely(audit, {
        action: 'SCORES_SAVED', actorId: actor.id, entityType: 'scores', entityId: input.classArmId, ip: c.ip, requestId: c.requestId,
        metadata: { subjectId: input.subjectId, termId: input.termId, saved: plan.writes.length, changes: plan.changes.slice(0, 40) },
      });
      return { saved: plan.writes.length };
    },

    /** Hands the subject to the admin for moderation. Every student needs every component filled in. Enter 0 for an absentee. */
    async submit(actor: Actor, input: GridQuery, c: Context) {
      const base = await teacherContext(actor, input);
      const [config, docs, profiles] = await Promise.all([
        settings.getAssessment(), scores.forGrid(input.classArmId, input.subjectId, input.termId), students.profileMap(base.studentIds),
      ]);
      if (base.studentIds.length === 0) throw new AppError('CONFLICT', { message: 'No students are enrolled in this class for this session' });
      if (docs.some((d) => d.locked)) throw new AppError('RESULT_LOCKED');

      const byStudent = new Map(docs.map((d) => [d.studentId, d]));
      const missing = base.studentIds.filter((id) => {
        const doc = byStudent.get(id);
        return !doc || !totalOf(doc.components, config).complete;
      });
      if (missing.length > 0) {
        throw new AppError('VALIDATION_ERROR', {
          message: 'Some students have missing scores',
          details: missing.slice(0, 50).map((id) => ({ field: profiles.get(id)?.name ?? id, issue: 'Scores are incomplete' })),
        });
      }

      const submitted = await scores.transition(input, SCORE_STATUS.DRAFT, SCORE_STATUS.SUBMITTED);
      await recordSafely(audit, {
        action: 'SCORES_SUBMITTED', actorId: actor.id, entityType: 'scores', entityId: input.classArmId, ip: c.ip, requestId: c.requestId,
        metadata: { subjectId: input.subjectId, termId: input.termId, submitted },
      });

      // When the last subject arrives, tell the admins the class is ready.
      if ((await ctx.readiness(input.classArmId, input.termId)).allSubmitted) {
        await notifier.notify({
          userIds: await users.findIdsByRoles([ROLES.ADMIN]), type: 'RESULTS_READY', title: 'Results ready for moderation',
          body: `${base.arm.name}: every subject has been submitted for ${base.term.name}.`, data: { classArmId: input.classArmId, termId: input.termId }, email: false,
        });
      }
      return { submitted, alreadySubmitted: base.studentIds.length - submitted };
    },
  };
}

export type ScoresService = ReturnType<typeof createScoresService>;