import { AppError } from '../../common/errors/AppError';
import type { ScopeService } from '../../common/scope/scope.service';
import { sanitizeText } from '../../common/utils/text';
import { ROLES, type Role } from '../../config/constants';
import type { assignmentRepository } from '../academics/assignment.repository';
import type { enrolmentRepository } from '../academics/enrolment.repository';
import type { sessionRepository } from '../academics/session.repository';
import type { structureRepository } from '../academics/structure.repository';
import { recordSafely, type AuditPort } from '../audit/audit.port';
import type { NotificationService } from '../notifications/notification.service';
import type { studentRepository } from '../users/student.repository';
import type { SubmissionRecord, SubmissionStatus, TaskRecord, taskRepository } from './task.repository';
import { SUBMISSION_STATUS } from './task.repository';

interface Actor { id: string; role: Role }
interface Context { ip: string; requestId: string }

export interface TaskServiceDeps {
  tasks: typeof taskRepository;
  assignments: Pick<typeof assignmentRepository, 'findById'>;
  enrolments: Pick<typeof enrolmentRepository, 'forStudents' | 'studentIdsInArms'>;
  sessions: Pick<typeof sessionRepository, 'findCurrentSession'>;
  structure: Pick<typeof structureRepository, 'armsByIds' | 'classesByIds' | 'subjectsByIds'>;
  students: Pick<typeof studentRepository, 'nameMap'>;
  scope: Pick<ScopeService, 'assertCanAccessStudent'>;
  notifier: Pick<NotificationService, 'notify'>;
  audit: AuditPort;
}

const fail = (field: string, issue: string): AppError => new AppError('VALIDATION_ERROR', { details: [{ field, issue }] });
const round1 = (n: number): number => Math.round(n * 10) / 10;
const percent = (score: number | null, max: number): number | null => (score === null ? null : round1((score / max) * 100));
const rate = (part: number, whole: number): number | null => (whole === 0 ? null : round1((part / whole) * 100));
const oneDecimal = (n: number): boolean => Math.abs(n * 10 - Math.round(n * 10)) < 1e-9;

type StudentStatusLabel = 'PENDING' | 'OVERDUE' | SubmissionStatus;

export function createTaskService(deps: TaskServiceDeps) {
  const { tasks, assignments, enrolments, sessions, structure, students, scope, notifier, audit } = deps;

  const log = (action: string, actor: Actor, ctx: Context, entityId: string, before: object | null, after: object | null) =>
    recordSafely(audit, {
      action, actorId: actor.id, entityType: 'task', entityId, ip: ctx.ip, requestId: ctx.requestId,
      before: before as Record<string, unknown> | null, after: after as Record<string, unknown> | null,
    });

  /** Adds class and subject names to a batch of tasks. */
  async function taskViews(records: TaskRecord[]) {
    const [arms, subjects] = await Promise.all([
      structure.armsByIds(records.map((t) => t.classArmId)),
      structure.subjectsByIds(records.map((t) => t.subjectId)),
    ]);
    const classes = await structure.classesByIds([...arms.values()].map((a) => a.classId));
    return records.map((t) => {
      const arm = arms.get(t.classArmId);
      return {
        id: t.id, teachingAssignmentId: t.teachingAssignmentId, teacherId: t.teacherId,
        classArmId: t.classArmId, classArmName: arm ? `${classes.get(arm.classId)?.name ?? ''} ${arm.name}`.trim() : '',
        subjectId: t.subjectId, subjectName: subjects.get(t.subjectId)?.name ?? '',
        title: t.title, instructions: t.instructions, dueAt: t.dueAt.toISOString(),
        maxScore: t.maxScore, countsToCA: t.countsToCA, createdAt: t.createdAt.toISOString(),
      };
    });
  }

  /** A teacher reaches only their own tasks. Admins read any. Everyone else is refused earlier. */
  async function loadTask(actor: Actor, id: string, write: boolean): Promise<TaskRecord> {
    const task = await tasks.findTask(id);
    if (!task) throw new AppError('NOT_FOUND');
    const own = task.teacherId === actor.id;
    if (!own && (write || actor.role !== ROLES.ADMIN)) throw new AppError('NOT_FOUND');
    return task;
  }

  const labelFor = (task: TaskRecord, sub: SubmissionRecord | undefined, now: Date): StudentStatusLabel =>
    sub ? sub.status : task.dueAt < now ? 'OVERDUE' : 'PENDING';

  async function currentArmOf(studentId: string): Promise<{ armId: string; sessionId: string } | null> {
    const current = await sessions.findCurrentSession();
    if (!current) return null;
    const armId = (await enrolments.forStudents([studentId], current.id)).get(studentId)?.classArmId;
    return armId ? { armId, sessionId: current.id } : null;
  }

  /** A student's tasks with their own submission status. Parents get the same without the submission text. */
  async function studentTasks(studentId: string, page: number, limit: number, includeText: boolean) {
    const where = await currentArmOf(studentId);
    if (!where) return { items: [], total: 0 };

    const { items, total } = await tasks.listTasks({ classArmId: where.armId, sessionId: where.sessionId }, { page, limit });
    const [views, subs] = await Promise.all([taskViews(items), tasks.submissionsOfStudent(studentId, items.map((t) => t.id))]);
    const now = new Date();

    return {
      total,
      items: items.map((task, i) => {
        const sub = subs.get(task.id);
        return {
          ...(views[i] as (typeof views)[number]),
          status: labelFor(task, sub, now),
          late: sub?.late ?? null,
          submittedAt: sub ? sub.submittedAt.toISOString() : null,
          score: sub?.score ?? null,
          percent: percent(sub?.score ?? null, task.maxScore),
          feedback: sub?.feedback ?? null,
          submissionText: includeText ? (sub?.text ?? null) : null,
        };
      }),
    };
  }

  return {
    async create(actor: Actor, input: { teachingAssignmentId: string; title: string; instructions: string; dueAt: string; maxScore: number; countsToCA: boolean }, ctx: Context) {
      const assignment = await assignments.findById(input.teachingAssignmentId);
      if (!assignment || assignment.teacherId !== actor.id) throw fail('teachingAssignmentId', 'You do not teach this subject in this class');

      const current = await sessions.findCurrentSession();
      if (!current || assignment.sessionId !== current.id) throw fail('teachingAssignmentId', 'Tasks can only be set for the current session');
      const dueAt = new Date(input.dueAt);
      if (dueAt <= new Date()) throw fail('dueAt', 'Must be in the future');
      if (!oneDecimal(input.maxScore)) throw fail('maxScore', 'At most one decimal place');

      const created = await tasks.createTask({
        teachingAssignmentId: assignment.id, teacherId: actor.id, classArmId: assignment.classArmId,
        subjectId: assignment.subjectId, sessionId: assignment.sessionId,
        title: sanitizeText(input.title), instructions: sanitizeText(input.instructions),
        dueAt, maxScore: input.maxScore, countsToCA: input.countsToCA,
      });

      const [view] = await taskViews([created]);
      if (!view) throw new Error('Task view could not be built');

      // Tell the class. A failure never fails the task.
      const classmates = await enrolments.studentIdsInArms([created.classArmId], created.sessionId);
      await notifier.notify({
        userIds: classmates, type: 'TASK_CREATED', title: `New task: ${view.title}`,
        body: `${view.subjectName}, due ${dueAt.toISOString().slice(0, 10)}.`, data: { taskId: created.id }, email: false,
      });

      await log('TASK_CREATED', actor, ctx, created.id, null, { title: view.title, dueAt: view.dueAt });
      return view;
    },

    async list(actor: Actor, input: { page: number; limit: number; teachingAssignmentId?: string | undefined; classArmId?: string | undefined; subjectId?: string | undefined; from?: string | undefined; to?: string | undefined }) {
      const { items, total } = await tasks.listTasks(
        {
          teacherId: actor.role === ROLES.TEACHER ? actor.id : undefined,
          teachingAssignmentId: input.teachingAssignmentId, classArmId: input.classArmId, subjectId: input.subjectId,
          from: input.from ? new Date(input.from) : undefined, to: input.to ? new Date(input.to) : undefined,
        },
        { page: input.page, limit: input.limit },
      );
      return { items: await taskViews(items), total };
    },

    async get(actor: Actor, id: string) {
      const [view] = await taskViews([await loadTask(actor, id, false)]);
      if (!view) throw new AppError('NOT_FOUND');
      return view;
    },

    async update(actor: Actor, id: string, patch: { title?: string; instructions?: string; dueAt?: string; maxScore?: number; countsToCA?: boolean }, ctx: Context) {
      if (Object.keys(patch).length === 0) throw fail('body', 'Nothing to update');
      const before = await loadTask(actor, id, true);

      if (patch.dueAt && new Date(patch.dueAt) <= new Date()) throw fail('dueAt', 'Must be in the future');
      if (patch.maxScore !== undefined) {
        if (!oneDecimal(patch.maxScore)) throw fail('maxScore', 'At most one decimal place');
        if (patch.maxScore < (await tasks.highestScore(id))) throw fail('maxScore', 'Lower than a score already given');
      }

      const updated = await tasks.updateTask(id, {
        ...(patch.title !== undefined ? { title: sanitizeText(patch.title) } : {}),
        ...(patch.instructions !== undefined ? { instructions: sanitizeText(patch.instructions) } : {}),
        ...(patch.dueAt !== undefined ? { dueAt: new Date(patch.dueAt) } : {}),
        ...(patch.maxScore !== undefined ? { maxScore: patch.maxScore } : {}),
        ...(patch.countsToCA !== undefined ? { countsToCA: patch.countsToCA } : {}),
      });
      if (!updated) throw new AppError('NOT_FOUND');

      const [view] = await taskViews([updated]);
      if (!view) throw new AppError('NOT_FOUND');
      await log('TASK_UPDATED', actor, ctx, id, { title: before.title, maxScore: before.maxScore }, { title: view.title, maxScore: view.maxScore });
      return view;
    },

    async remove(actor: Actor, id: string, ctx: Context): Promise<void> {
      const task = await loadTask(actor, id, true);
      if (await tasks.hasSubmissions(id)) throw new AppError('CONFLICT', { message: 'Students have already submitted, so this task cannot be deleted' });
      await tasks.deleteTask(id);
      await log('TASK_DELETED', actor, ctx, id, { title: task.title }, null);
    },

    /** The grading screen: every student of the class, with or without a submission. */
    async submissions(actor: Actor, id: string) {
      const task = await loadTask(actor, id, true);
      const [studentIds, subs] = await Promise.all([enrolments.studentIdsInArms([task.classArmId], task.sessionId), tasks.submissionsOfTask(id)]);
      const names = await students.nameMap(studentIds);
      const byStudent = new Map(subs.map((s) => [s.studentId, s]));
      const now = new Date();

      return studentIds
        .map((studentId) => {
          const sub = byStudent.get(studentId);
          return {
            submissionId: sub?.id ?? null, studentId, studentName: names.get(studentId) ?? '',
            status: labelFor(task, sub, now), late: sub?.late ?? null,
            submittedAt: sub ? sub.submittedAt.toISOString() : null,
            text: sub?.text ?? null, score: sub?.score ?? null, percent: percent(sub?.score ?? null, task.maxScore), feedback: sub?.feedback ?? null,
          };
        })
        .sort((a, b) => a.studentName.localeCompare(b.studentName));
    },

    /** GRADE gives a mark. RETURN sends it back to the student with feedback so they can resubmit. */
    async grade(actor: Actor, submissionId: string, input: { action: 'GRADE' | 'RETURN'; score?: number | undefined; feedback?: string | undefined }, ctx: Context) {
      const submission = await tasks.findSubmission(submissionId);
      const task = submission ? await tasks.findTask(submission.taskId) : null;
      if (!submission || !task || task.teacherId !== actor.id) throw new AppError('NOT_FOUND');

      const feedback = input.feedback ? sanitizeText(input.feedback) || null : null;
      let patch: { status: SubmissionStatus; score: number | null; feedback: string | null };
      if (input.action === 'GRADE') {
        if (input.score === undefined) throw fail('score', 'A score is required');
        if (input.score < 0 || input.score > task.maxScore) throw fail('score', `Must be between 0 and ${task.maxScore}`);
        if (!oneDecimal(input.score)) throw fail('score', 'At most one decimal place');
        patch = { status: SUBMISSION_STATUS.GRADED, score: input.score, feedback };
      } else {
        if (!feedback) throw fail('feedback', 'Say what needs to change');
        patch = { status: SUBMISSION_STATUS.RETURNED, score: null, feedback };
      }

      const updated = await tasks.applyGrade(submissionId, [SUBMISSION_STATUS.SUBMITTED, SUBMISSION_STATUS.GRADED], patch, actor.id, new Date());
      if (!updated) throw new AppError('CONFLICT', { message: 'This submission is waiting for the student to resubmit' });

      await log(input.action === 'GRADE' ? 'TASK_GRADED' : 'TASK_RETURNED', actor, ctx, task.id,
        { submissionId, score: submission.score, status: submission.status }, { submissionId, score: updated.score, status: updated.status });
      await notifier.notify({
        userIds: [submission.studentId], type: input.action === 'GRADE' ? 'TASK_GRADED' : 'TASK_RETURNED',
        title: input.action === 'GRADE' ? 'Your task was graded' : 'Your task was returned',
        body: `${task.title}${input.action === 'GRADE' ? `: ${updated.score}/${task.maxScore}` : ' needs changes'}`,
        data: { taskId: task.id }, email: false,
      });
      return { submissionId, status: updated.status, score: updated.score, percent: percent(updated.score, task.maxScore), feedback: updated.feedback };
    },

    async myTasks(actor: Actor, input: { page: number; limit: number }) {
      return studentTasks(actor.id, input.page, input.limit, true);
    },

    async childTasks(actor: Actor, studentId: string, input: { page: number; limit: number }) {
      await scope.assertCanAccessStudent(actor, studentId); // a parent reaches only their linked children
      return studentTasks(studentId, input.page, input.limit, false);
    },

    /** Submitting again before grading, or after a return, replaces the earlier text. Late work is accepted and flagged. */
    async submit(actor: Actor, taskId: string, input: { text: string }) {
      const task = await tasks.findTask(taskId);
      const where = await currentArmOf(actor.id);
      if (!task || !where || where.armId !== task.classArmId || where.sessionId !== task.sessionId) throw new AppError('NOT_FOUND');

      const text = sanitizeText(input.text);
      if (!text) throw fail('text', 'Write your answer');
      const now = new Date();
      const saved = await tasks.upsertSubmission(taskId, actor.id, text, now > task.dueAt, now);
      if (!saved) throw new AppError('CONFLICT', { message: 'This task has been graded and can no longer be changed' });

      return { submissionId: saved.id, status: saved.status, late: saved.late, submittedAt: saved.submittedAt.toISOString() };
    },

    async analytics(actor: Actor) {
      const where = await currentArmOf(actor.id);
      const empty = { assigned: 0, submitted: 0, completionRate: null, onTimeRate: null, streak: 0, scoreTrend: [], bySubject: [] };
      if (!where) return empty;

      const all = await tasks.allTasksForArm(where.armId, where.sessionId);
      const subs = await tasks.submissionsOfStudent(actor.id, all.map((t) => t.id));
      const now = new Date();

      // A task counts once it is due, or earlier if the student already handed something in.
      const counted = all.filter((t) => t.dueAt <= now || subs.has(t.id));
      const submitted = counted.filter((t) => subs.has(t.id));
      const onTime = submitted.filter((t) => subs.get(t.id)?.late === false);

      let streak = 0;
      for (const t of counted.filter((x) => x.dueAt <= now)) { // newest due first
        if (subs.get(t.id)?.late === false) streak += 1;
        else break;
      }

      const scoreTrend = all
        .flatMap((t) => {
          const s = subs.get(t.id);
          return s?.status === SUBMISSION_STATUS.GRADED && s.score !== null && s.gradedAt ? [{ taskId: t.id, title: t.title, percent: round1((s.score / t.maxScore) * 100), at: s.gradedAt }] : [];
        })
        .sort((a, b) => a.at.getTime() - b.at.getTime())
        .slice(-10)
        .map((p) => ({ ...p, at: p.at.toISOString() }));

      const subjects = await structure.subjectsByIds(counted.map((t) => t.subjectId));
      const bySubject = [...new Set(counted.map((t) => t.subjectId))].map((subjectId) => {
        const forSubject = counted.filter((t) => t.subjectId === subjectId);
        const done = forSubject.filter((t) => subs.has(t.id)).length;
        return { subjectId, subjectName: subjects.get(subjectId)?.name ?? '', assigned: forSubject.length, submitted: done, completionRate: rate(done, forSubject.length) };
      });

      return {
        assigned: counted.length, submitted: submitted.length,
        completionRate: rate(submitted.length, counted.length), onTimeRate: rate(onTime.length, submitted.length),
        streak, scoreTrend, bySubject,
      };
    },
  };
}

export type TaskService = ReturnType<typeof createTaskService>;