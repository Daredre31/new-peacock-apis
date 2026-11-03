import { AppError } from '../../common/errors/AppError';
import { schoolToday } from '../../common/utils/dates';
import { sanitizeText } from '../../common/utils/text';
import { ROLES, type Role } from '../../config/constants';
import type { assignmentRepository } from '../academics/assignment.repository';
import type { enrolmentRepository } from '../academics/enrolment.repository';
import type { sessionRepository } from '../academics/session.repository';
import type { structureRepository } from '../academics/structure.repository';
import { recordSafely, type AuditPort } from '../audit/audit.port';
import type { NotificationService } from '../notifications/notification.service';
import { planWrites, scoreKey, teacherCanEdit, type PlanEntry } from '../results/scores.plan';
import { writeScores } from '../results/scores.service';
import type { scoreRepository } from '../results/score.repository';
import type { AssessmentConfig } from '../settings/assessment';
import type { staffRepository } from '../users/staff.repository';
import type { userRepository } from '../users/user.repository';
import type { attemptRepository } from './attempt.repository';
import { DEFAULT_SETTINGS, EXAM_STATUS, type ExamSettings, type ExamStatus, type ExamType } from './cbt.types';
import type { ExamFields, ExamRecord, examRepository } from './exam.repository';
import type { PaperCache } from './paper.cache';
import type { questionRepository } from './question.repository';

interface Actor { id: string; role: Role }
interface Context { ip: string; requestId: string }

export interface ExamInput {
  title: string; subjectId: string; classArmIds: string[]; type: ExamType; durationMin: number;
  windowStart: string; windowEnd: string; instructions?: string | undefined; settings?: Partial<ExamSettings> | undefined;
}

export interface ExamServiceDeps {
  exams: typeof examRepository;
  questions: Pick<typeof questionRepository, 'forExamWithKey' | 'removeForExam'>;
  attempts: Pick<typeof attemptRepository, 'allForExam' | 'countForExam'>;
  enrolments: Pick<typeof enrolmentRepository, 'studentIdsInArms'>;
  sessions: Pick<typeof sessionRepository, 'findCurrentSession' | 'findTermByDate'>;
  structure: Pick<typeof structureRepository, 'subjectsByIds' | 'armsByIds' | 'classesByIds'>;
  assignments: Pick<typeof assignmentRepository, 'holds'>;
  staff: Pick<typeof staffRepository, 'nameMap'>;
  settings: { getAssessment(): Promise<AssessmentConfig> };
  scores: Pick<typeof scoreRepository, 'forGrid' | 'saveMany'>;
  users: Pick<typeof userRepository, 'findIdsByRoles'>;
  notifier: Pick<NotificationService, 'notify'>;
  paper: PaperCache;
  finalizeOverdueFor: (examId: string) => Promise<number>;
  audit: AuditPort;
}

const fail = (field: string, issue: string): AppError => new AppError('VALIDATION_ERROR', { details: [{ field, issue }] });
const EDITABLE: ExamStatus[] = [EXAM_STATUS.DRAFT, EXAM_STATUS.REJECTED];
const isStaff = (role: Role): boolean => role === ROLES.ADMIN || role === ROLES.SUPER_ADMIN;
const when = (d: Date): string => d.toISOString().slice(0, 16).replace('T', ' ');

export function createExamService(deps: ExamServiceDeps) {
  const { exams, questions, attempts, enrolments, sessions, structure, assignments, staff, settings, scores, users, notifier, paper, audit } = deps;

  const log = (action: string, actor: Actor, ctx: Context, id: string, metadata: Record<string, unknown>) =>
    recordSafely(audit, { action, actorId: actor.id, entityType: 'exam', entityId: id, ip: ctx.ip, requestId: ctx.requestId, metadata });

  async function viewsOf(records: ExamRecord[]) {
    const [subjects, arms, teachers] = await Promise.all([
      structure.subjectsByIds(records.map((e) => e.subjectId)), structure.armsByIds(records.flatMap((e) => e.classArmIds)),
      staff.nameMap(records.map((e) => e.teacherId)),
    ]);
    const classes = await structure.classesByIds([...arms.values()].map((a) => a.classId));
    return records.map((e) => ({
      id: e.id, title: e.title, subjectId: e.subjectId, subjectName: subjects.get(e.subjectId)?.name ?? '',
      classArms: e.classArmIds.flatMap((id) => { const a = arms.get(id); return a ? [{ id, name: `${classes.get(a.classId)?.name ?? ''} ${a.name}`.trim() }] : []; }),
      teacherId: e.teacherId, teacherName: teachers.get(e.teacherId) ?? '', sessionId: e.sessionId, termId: e.termId, type: e.type,
      durationMin: e.durationMin, windowStart: e.windowStart.toISOString(), windowEnd: e.windowEnd.toISOString(),
      instructions: e.instructions, settings: e.settings, status: e.status, rejectionReason: e.rejectionReason,
      resultsReleased: e.resultsReleased, questionCount: e.questionCount, maxScore: e.maxScore, createdAt: e.createdAt.toISOString(),
    }));
  }
  const viewOf = async (e: ExamRecord) => {
    const [v] = await viewsOf([e]);
    if (!v) throw new Error('Exam view could not be built');
    return v;
  };

  /** Staff reach exams like this: the owning teacher, or an admin or super admin. Everyone else gets "not found". */
  async function accessible(actor: Actor, id: string): Promise<ExamRecord> {
    const exam = await exams.findById(id);
    if (!exam || !(isStaff(actor.role) || (actor.role === ROLES.TEACHER && exam.teacherId === actor.id))) throw new AppError('NOT_FOUND');
    return exam;
  }
  async function owned(actor: Actor, id: string): Promise<ExamRecord> {
    const exam = await exams.findById(id);
    if (!exam || exam.teacherId !== actor.id) throw new AppError('NOT_FOUND');
    return exam;
  }

  /** Checks everything about an exam's fields and works out the session and term it belongs to. */
  async function validate(actor: Actor, input: ExamInput & { settings: ExamSettings }) {
    const windowStart = new Date(input.windowStart);
    const windowEnd = new Date(input.windowEnd);
    if (windowEnd <= new Date()) throw fail('windowEnd', 'Must be in the future');
    if (windowEnd.getTime() - windowStart.getTime() < input.durationMin * 60_000) throw fail('windowEnd', 'The window must be at least as long as the duration');
    if (windowEnd.getTime() - windowStart.getTime() > 14 * 86_400_000) throw fail('windowEnd', 'The window cannot be longer than 14 days');

    const current = await sessions.findCurrentSession();
    if (!current) throw fail('windowStart', 'There is no current session');
    const term = await sessions.findTermByDate(schoolToday(windowStart.getTime()));
    if (!term || term.sessionId !== current.id) throw fail('windowStart', 'Must fall inside a term of the current session');
    if (term.locked) throw new AppError('CONFLICT', { message: 'This term is closed' });

    const subject = (await structure.subjectsByIds([input.subjectId])).get(input.subjectId);
    if (!subject) throw fail('subjectId', 'Subject not found');
    const armIds = [...new Set(input.classArmIds)];
    const arms = await structure.armsByIds(armIds);
    if (arms.size !== armIds.length) throw fail('classArmIds', 'One or more class arms do not exist');
    for (const armId of armIds) {
      if (!(await assignments.holds(actor.id, input.subjectId, armId, current.id))) {
        throw fail('classArmIds', 'You do not teach this subject in every one of these classes');
      }
    }

    if (input.settings.scoreComponent) {
      const config = await settings.getAssessment();
      if (!config.components.some((c) => c.key === input.settings.scoreComponent)) {
        throw fail('settings.scoreComponent', `Must be one of: ${config.components.map((c) => c.key).join(', ')}`);
      }
    }

    const fields: ExamFields = {
      title: sanitizeText(input.title), subjectId: input.subjectId, classArmIds: armIds, teacherId: actor.id,
      sessionId: current.id, termId: term.id, type: input.type, durationMin: input.durationMin, windowStart, windowEnd,
      instructions: sanitizeText(input.instructions ?? ''), settings: input.settings,
    };
    return fields;
  }

  async function studentsOf(exam: ExamRecord): Promise<string[]> {
    return enrolments.studentIdsInArms(exam.classArmIds, exam.sessionId);
  }

  async function publishNotices(exam: ExamRecord): Promise<void> {
    await notifier.notify({
      userIds: await studentsOf(exam), type: 'EXAM_PUBLISHED', title: `Exam: ${exam.title}`,
      body: `Opens ${when(exam.windowStart)}, closes ${when(exam.windowEnd)} (${exam.durationMin} minutes).`, data: { examId: exam.id }, email: false,
    });
  }

  /** Copies each student's score, scaled to the component's maximum, into the score grid as a draft. Never touches submitted or locked scores. */
  async function feedScores(exam: ExamRecord, actorId: string): Promise<{ fed: number; skipped: number }> {
    const key = exam.settings.scoreComponent;
    if (!key || exam.maxScore <= 0) return { fed: 0, skipped: 0 };
    const config = await settings.getAssessment();
    const component = config.components.find((c) => c.key === key);
    if (!component) return { fed: 0, skipped: 0 };

    const submitted = (await attempts.allForExam(exam.id)).filter((a) => a.graded && a.score !== null);
    let fed = 0;
    let skipped = 0;

    for (const armId of exam.classArmIds) {
      const enrolled = new Set(await enrolments.studentIdsInArms([armId], exam.sessionId));
      const docs = await scores.forGrid(armId, exam.subjectId, exam.termId);
      const existing = new Map(docs.map((d) => [scoreKey(d.studentId, d.subjectId), d]));

      const entries: PlanEntry[] = [];
      for (const a of submitted) {
        if (!enrolled.has(a.studentId) || a.score === null) continue;
        if (teacherCanEdit(existing.get(scoreKey(a.studentId, exam.subjectId))) !== 'OK') { skipped += 1; continue; }
        const scaled = Math.min(component.max, Math.round((a.score / exam.maxScore) * component.max * 10) / 10);
        entries.push({ studentId: a.studentId, subjectId: exam.subjectId, components: { [key]: scaled } });
      }
      if (entries.length === 0) continue;

      const plan = planWrites({ armId, termId: exam.termId, entries, existing, enrolled, config, canEdit: teacherCanEdit });
      await writeScores(scores, plan.writes, actorId);
      fed += plan.writes.length;
    }
    return { fed, skipped };
  }

  return {
    async create(actor: Actor, input: ExamInput, ctx: Context) {
      const fields = await validate(actor, { ...input, settings: { ...DEFAULT_SETTINGS, ...input.settings } });
      const created = await exams.create(fields);
      await log('EXAM_CREATED', actor, ctx, created.id, { title: created.title, type: created.type });
      return viewOf(created);
    },

    async update(actor: Actor, id: string, patch: Partial<ExamInput>, ctx: Context) {
      if (Object.values(patch).every((v) => v === undefined)) throw fail('body', 'Nothing to update');
      const before = await owned(actor, id);
      if (!EDITABLE.includes(before.status)) throw new AppError('CONFLICT', { message: 'Only a draft or a rejected exam can be changed' });

      const merged: ExamInput & { settings: ExamSettings } = {
        title: patch.title ?? before.title, subjectId: patch.subjectId ?? before.subjectId, classArmIds: patch.classArmIds ?? before.classArmIds,
        type: patch.type ?? before.type, durationMin: patch.durationMin ?? before.durationMin,
        windowStart: patch.windowStart ?? before.windowStart.toISOString(), windowEnd: patch.windowEnd ?? before.windowEnd.toISOString(),
        instructions: patch.instructions ?? before.instructions, settings: { ...before.settings, ...patch.settings },
      };
    const fields = await validate(actor, merged);
      

      const updated = await exams.updateEditable(id, actor.id, fields);
      if (!updated) throw new AppError('CONFLICT', { message: 'This exam was just changed. Reload it.' });
      await log('EXAM_UPDATED', actor, ctx, id, { title: updated.title });
      return viewOf(updated);
    },

    async remove(actor: Actor, id: string, ctx: Context): Promise<void> {
      const exam = await exams.findById(id);
      const allowed = exam && (actor.role === ROLES.ADMIN || (actor.role === ROLES.TEACHER && exam.teacherId === actor.id));
      if (!exam || !allowed) throw new AppError('NOT_FOUND');
      if ((await attempts.countForExam(id)) > 0) throw new AppError('CONFLICT', { message: 'Students have already started this exam, so it cannot be deleted' });

      await questions.removeForExam(id);
      await exams.remove(id);
      await paper.invalidate(id);
      await log('EXAM_DELETED', actor, ctx, id, { title: exam.title, status: exam.status });
    },

    async get(actor: Actor, id: string) {
      return viewOf(await accessible(actor, id));
    },

    async list(actor: Actor, input: { page: number; limit: number; status?: ExamStatus | undefined; type?: ExamType | undefined; subjectId?: string | undefined; classArmId?: string | undefined; from?: string | undefined; to?: string | undefined }) {
      const { items, total } = await exams.list(
        {
          teacherId: actor.role === ROLES.TEACHER ? actor.id : undefined, status: input.status, type: input.type, subjectId: input.subjectId,
          classArmId: input.classArmId, from: input.from ? new Date(input.from) : undefined, to: input.to ? new Date(input.to) : undefined,
        },
        { page: input.page, limit: input.limit },
      );
      return { items: await viewsOf(items), total };
    },

    /** Staff review the paper, with the answers, before approving. */
    async questionsFor(actor: Actor, id: string) {
      await accessible(actor, id);
      return (await questions.forExamWithKey(id)).map((q) => ({
        id: q.id, order: q.order, type: q.type, text: q.text, options: q.options, correctAnswer: q.correctAnswer,
        marks: q.marks, topic: q.topic, difficulty: q.difficulty, explanation: q.explanation,
      }));
    },

    /** A class test goes live straight away. A term exam waits for an admin. */
    async submitForApproval(actor: Actor, id: string, ctx: Context) {
      const exam = await owned(actor, id);
      if (!EDITABLE.includes(exam.status)) throw new AppError('CONFLICT', { message: 'This exam has already been submitted' });
      if (exam.questionCount === 0) throw fail('questions', 'Upload and confirm the questions first');
      if (exam.windowEnd <= new Date()) throw fail('windowEnd', 'The exam window has already passed. Change the dates first');

      const to = exam.type === 'CLASS_TEST' ? EXAM_STATUS.PUBLISHED : EXAM_STATUS.PENDING_APPROVAL;
      const updated = await exams.transition(id, EDITABLE, to, { rejectionReason: null });
      if (!updated) throw new AppError('CONFLICT', { message: 'This exam was just changed. Reload it.' });

      if (to === EXAM_STATUS.PUBLISHED) await publishNotices(updated);
      else {
        await notifier.notify({
          userIds: await users.findIdsByRoles([ROLES.ADMIN]), type: 'EXAM_PENDING', title: 'An exam needs approval',
          body: `"${updated.title}" is waiting for your approval.`, data: { examId: id }, email: false,
        });
      }
      await log(to === EXAM_STATUS.PUBLISHED ? 'EXAM_PUBLISHED' : 'EXAM_SUBMITTED', actor, ctx, id, { type: exam.type });
      return viewOf(updated);
    },

    async approve(actor: Actor, id: string, ctx: Context) {
      const exam = await exams.findById(id);
      if (!exam) throw new AppError('NOT_FOUND');
      if (exam.windowEnd <= new Date()) throw fail('windowEnd', 'The exam window has already passed. Ask the teacher to change the dates');

      const updated = await exams.transition(id, [EXAM_STATUS.PENDING_APPROVAL], EXAM_STATUS.PUBLISHED, { rejectionReason: null, decidedBy: actor.id, decidedAt: new Date() });
      if (!updated) throw new AppError('CONFLICT', { message: 'This exam is not waiting for approval' });

      await publishNotices(updated);
      await notifier.notify({ userIds: [exam.teacherId], type: 'EXAM_APPROVED', title: 'Your exam was approved', body: `"${exam.title}" is now published.`, data: { examId: id }, email: false });
      await log('EXAM_APPROVED', actor, ctx, id, {});
      return viewOf(updated);
    },

    async reject(actor: Actor, id: string, input: { reason: string }, ctx: Context) {
      const reason = sanitizeText(input.reason);
      if (!reason) throw fail('reason', 'A reason is required');
      const updated = await exams.transition(id, [EXAM_STATUS.PENDING_APPROVAL], EXAM_STATUS.REJECTED, { rejectionReason: reason, decidedBy: actor.id, decidedAt: new Date() });
      if (!updated) {
        if (!(await exams.findById(id))) throw new AppError('NOT_FOUND');
        throw new AppError('CONFLICT', { message: 'This exam is not waiting for approval' });
      }
      await notifier.notify({ userIds: [updated.teacherId], type: 'EXAM_REJECTED', title: 'Your exam was sent back', body: `"${updated.title}": ${reason}`, data: { examId: id }, email: false });
      await log('EXAM_REJECTED', actor, ctx, id, { reason });
      return viewOf(updated);
    },

    /** After the window closes: ends any attempt still running, makes results visible, optionally feeds the score grid. */
    async releaseResults(actor: Actor, id: string, ctx: Context) {
      const exam = await owned(actor, id);
      if (exam.status !== EXAM_STATUS.PUBLISHED) throw new AppError('CONFLICT', { message: 'This exam is not published' });
      if (exam.resultsReleased) return { released: true, alreadyReleased: true, fed: 0, skipped: 0 };
      if (exam.windowEnd > new Date()) throw new AppError('CONFLICT', { message: 'Results can be released once the exam window has closed' });

      await deps.finalizeOverdueFor(id);
      const released = await exams.markReleased(id, new Date());
      if (!released) return { released: true, alreadyReleased: true, fed: 0, skipped: 0 };

      const { fed, skipped } = await feedScores(released, actor.id);
      await notifier.notify({
        userIds: await studentsOf(released), type: 'EXAM_RESULTS', title: 'Exam results released',
        body: `Your result for "${released.title}" is available.`, data: { examId: id }, email: false,
      });
      await log('EXAM_RESULTS_RELEASED', actor, ctx, id, { fed, skipped, component: released.settings.scoreComponent });
      return { released: true, alreadyReleased: false, fed, skipped };
    },
  };
}

export type ExamService = ReturnType<typeof createExamService>;