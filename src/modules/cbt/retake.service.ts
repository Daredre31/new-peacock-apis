import { AppError } from '../../common/errors/AppError';
import { sanitizeText } from '../../common/utils/text';
import { ROLES, type Role } from '../../config/constants';
import type { enrolmentRepository } from '../academics/enrolment.repository';
import { recordSafely, type AuditPort } from '../audit/audit.port';
import type { NotificationService } from '../notifications/notification.service';
import type { staffRepository } from '../users/staff.repository';
import type { studentRepository } from '../users/student.repository';
import type { userRepository } from '../users/user.repository';
import { ATTEMPT_STATUS, type attemptRepository } from './attempt.repository';
import type { attemptHistoryRepository } from './attempt.history.repository';
import { EXAM_STATUS, GRACE_MS } from './cbt.types';
import type { ExamRecord, examRepository } from './exam.repository';
import { RETAKE_STATUS, type NewRetake, type RetakeRecord, type RetakeStatus, type retakeRepository } from './retake.repository';

interface Actor { id: string; role: Role }
interface Context { ip: string; requestId: string }

const round1 = (n: number): number => Math.round(n * 10) / 10;
const fail = (field: string, issue: string): AppError => new AppError('VALIDATION_ERROR', { details: [{ field, issue }] });
const isAdmin = (role: Role): boolean => role === ROLES.ADMIN || role === ROLES.SUPER_ADMIN;
const when = (d: Date): string => d.toISOString().slice(0, 16).replace('T', ' ');

/**
 * Retakes. A teacher asks for one for a student who failed badly or hit a fault; an admin approves or refuses.
 * An approval can be used once. When the student starts the retake, their earlier sitting moves to the attempt
 * history and the new sitting becomes their current one (see attempt.service). Only the current sitting is ever
 * shown to parents or counted in results; the history is for admins and the exam's teacher.
 */
export function createRetakeService(deps: {
  exams: Pick<typeof examRepository, 'findById'>;
  retakes: typeof retakeRepository;
  attempts: Pick<typeof attemptRepository, 'findByExamStudent'>;
  history: Pick<typeof attemptHistoryRepository, 'forStudent'>;
  enrolments: Pick<typeof enrolmentRepository, 'forStudents'>;
  students: Pick<typeof studentRepository, 'nameMap'>;
  staff: Pick<typeof staffRepository, 'nameMap'>;
  users: Pick<typeof userRepository, 'findIdsByRoles'>;
  notifier: Pick<NotificationService, 'notify'>;
  audit: AuditPort;
}) {
  const { exams, retakes, attempts, history, enrolments, students, staff, users, notifier, audit } = deps;

  const log = (action: string, actor: Actor, ctx: Context, examId: string, metadata: Record<string, unknown>) =>
    recordSafely(audit, { action, actorId: actor.id, entityType: 'exam', entityId: examId, ip: ctx.ip, requestId: ctx.requestId, metadata });

  /** The teacher who owns the exam, an admin or the super admin. */
  async function accessible(actor: Actor, examId: string): Promise<ExamRecord> {
    const exam = await exams.findById(examId);
    if (!exam || !(isAdmin(actor.role) || (actor.role === ROLES.TEACHER && exam.teacherId === actor.id))) throw new AppError('NOT_FOUND');
    return exam;
  }

  async function mustRetake(examId: string, retakeId: string): Promise<RetakeRecord> {
    const retake = await retakes.findById(retakeId);
    if (!retake || retake.examId !== examId) throw new AppError('NOT_FOUND');
    return retake;
  }

  function assertNotReleased(exam: ExamRecord): void {
    if (exam.resultsReleased) {
      throw new AppError('CONFLICT', { message: 'Results for this exam have already been released and copied to the score grid, so it can no longer be retaken' });
    }
  }

  async function viewsOf(records: RetakeRecord[], knownExam?: ExamRecord) {
    const examIds = [...new Set(records.map((r) => r.examId))];
    const [studentNames, staffNames, titles] = await Promise.all([
      students.nameMap(records.map((r) => r.studentId)),
      staff.nameMap(records.flatMap((r) => (r.decidedBy ? [r.requestedBy, r.decidedBy] : [r.requestedBy]))),
      Promise.all(examIds.map(async (id) => [id, knownExam && knownExam.id === id ? knownExam.title : ((await exams.findById(id))?.title ?? '')] as const)),
    ]);
    const titleOf = new Map(titles);
    return records.map((r) => ({
      id: r.id, examId: r.examId, examTitle: titleOf.get(r.examId) ?? '', studentId: r.studentId, studentName: studentNames.get(r.studentId) ?? '',
      reason: r.reason, status: r.status, attemptNumber: r.attemptNumber,
      requestedBy: r.requestedBy, requestedByName: staffNames.get(r.requestedBy) ?? '', createdAt: r.createdAt.toISOString(),
      decidedBy: r.decidedBy, decidedByName: r.decidedBy ? (staffNames.get(r.decidedBy) ?? '') : null,
      decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null, decisionNote: r.decisionNote,
      expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null, usedAt: r.usedAt ? r.usedAt.toISOString() : null,
    }));
  }

  async function viewOne(record: RetakeRecord, knownExam?: ExamRecord) {
    const [view] = await viewsOf([record], knownExam);
    if (!view) throw new Error('Retake view could not be built');
    return view;
  }

  return {
    /** A teacher asks for a retake for one or more students of their own exam. Nothing happens until an admin approves. */
    async request(actor: Actor, examId: string, input: { studentIds: string[]; reason: string }, ctx: Context) {
      const exam = await exams.findById(examId);
      if (!exam || exam.teacherId !== actor.id) throw new AppError('NOT_FOUND');
      if (exam.status !== EXAM_STATUS.PUBLISHED) throw new AppError('CONFLICT', { message: 'Only a published exam can be retaken' });
      assertNotReleased(exam);
      const reason = sanitizeText(input.reason);
      if (reason.length < 3) throw fail('reason', 'A reason is required');

      const ids = [...new Set(input.studentIds)];
      const [enrolled, found] = await Promise.all([enrolments.forStudents(ids, exam.sessionId), Promise.all(ids.map((id) => attempts.findByExamStudent(examId, id)))]);
      const now = Date.now();
      const eligible: NewRetake[] = [];
      const skipped: { studentId: string; reason: string }[] = [];
      ids.forEach((studentId, i) => {
        const armId = enrolled.get(studentId)?.classArmId;
        const attempt = found[i];
        if (!armId || !exam.classArmIds.includes(armId)) skipped.push({ studentId, reason: 'This student is not in the classes taking this exam' });
        else if (!attempt) skipped.push({ studentId, reason: 'This student has not sat the exam yet' });
        else if (attempt.status !== ATTEMPT_STATUS.SUBMITTED && attempt.endsAt.getTime() + GRACE_MS >= now) skipped.push({ studentId, reason: 'This student is still sitting the exam' });
        else eligible.push({ examId, studentId, requestedBy: actor.id, reason, attemptId: attempt.id, attemptNumber: attempt.attemptNumber });
      });

      const { created, duplicates } = await retakes.createMany(eligible);
      for (const studentId of duplicates) skipped.push({ studentId, reason: 'This student already has a retake request for this exam that is waiting or unused' });

      if (created.length > 0) {
        await notifier.notify({
          userIds: await users.findIdsByRoles([ROLES.ADMIN]), type: 'EXAM_RETAKE_REQUESTED', title: 'A retake needs approval',
          body: `${created.length} ${created.length === 1 ? 'student needs' : 'students need'} a retake of "${exam.title}". Reason: ${reason}`.slice(0, 500),
          data: { examId }, email: false,
        });
        await log('EXAM_RETAKE_REQUESTED', actor, ctx, examId, { students: created.map((r) => r.studentId), reason });
      }
      return { requested: await viewsOf(created, exam), skipped };
    },

    /** Teachers see the requests they made. Admins and the super admin see everyone's. */
    async list(actor: Actor, input: { examId?: string | undefined; status?: RetakeStatus | undefined; page: number; limit: number }) {
      if (input.examId) await accessible(actor, input.examId);
      const { items, total } = await retakes.list(
        { examId: input.examId, status: input.status, requestedBy: actor.role === ROLES.TEACHER ? actor.id : undefined },
        { page: input.page, limit: input.limit },
      );
      return { items: await viewsOf(items), total };
    },

    async approve(actor: Actor, examId: string, retakeId: string, input: { expiresAt?: string | undefined }, ctx: Context) {
      const retake = await mustRetake(examId, retakeId);
      const exam = await exams.findById(examId);
      if (!exam) throw new AppError('NOT_FOUND');
      assertNotReleased(exam);
      const now = new Date();
      let expiresAt: Date | null = null;
      if (input.expiresAt) {
        expiresAt = new Date(input.expiresAt);
        if (expiresAt <= now) throw fail('expiresAt', 'Must be in the future');
      }
      const done = await retakes.approve(retake.id, actor.id, now, expiresAt);
      if (!done) throw new AppError('CONFLICT', { message: 'This request has already been decided' });

      await notifier.notify({
        userIds: [retake.requestedBy], type: 'EXAM_RETAKE_APPROVED', title: 'A retake was approved',
        body: `The retake of "${exam.title}" you asked for was approved.`, data: { examId }, email: false,
      });
      await notifier.notify({
        userIds: [retake.studentId], type: 'EXAM_RETAKE_APPROVED', title: 'You can retake an exam',
        body: `You may sit "${exam.title}" again${expiresAt ? `. Start it before ${when(expiresAt)} UTC` : ''}.`, data: { examId }, email: false,
      });
      await log('EXAM_RETAKE_APPROVED', actor, ctx, examId, { retakeId, studentId: retake.studentId, expiresAt: expiresAt ? expiresAt.toISOString() : null });
      return viewOne(done, exam);
    },

    async reject(actor: Actor, examId: string, retakeId: string, input: { reason: string }, ctx: Context) {
      const retake = await mustRetake(examId, retakeId);
      const note = sanitizeText(input.reason);
      if (note.length < 3) throw fail('reason', 'A reason is required');
      const done = await retakes.reject(retake.id, actor.id, new Date(), note);
      if (!done) throw new AppError('CONFLICT', { message: 'This request has already been decided' });

      const exam = await exams.findById(examId);
      await notifier.notify({
        userIds: [retake.requestedBy], type: 'EXAM_RETAKE_REJECTED', title: 'A retake was refused',
        body: `${exam ? `"${exam.title}": ` : ''}${note}`.slice(0, 500), data: { examId }, email: false,
      });
      await log('EXAM_RETAKE_REJECTED', actor, ctx, examId, { retakeId, studentId: retake.studentId, reason: note });
      return viewOne(done, exam ?? undefined);
    },

    /** The teacher can withdraw a request that is waiting. An admin can also cancel an approval nobody has used. */
    async revoke(actor: Actor, examId: string, retakeId: string, ctx: Context) {
      const exam = await accessible(actor, examId);
      const retake = await mustRetake(examId, retakeId);
      if (actor.role === ROLES.TEACHER && retake.requestedBy !== actor.id) throw new AppError('NOT_FOUND');
      const admin = isAdmin(actor.role);
      const done = await retakes.revoke(retake.id, admin ? [RETAKE_STATUS.PENDING, RETAKE_STATUS.APPROVED] : [RETAKE_STATUS.PENDING], actor.id, new Date());
      if (!done) {
        throw new AppError('CONFLICT', { message: admin ? 'Only a request that is waiting, or approved and not yet used, can be cancelled' : 'Only a request that is still waiting can be withdrawn' });
      }
      if (retake.requestedBy !== actor.id) {
        await notifier.notify({
          userIds: [retake.requestedBy], type: 'EXAM_RETAKE_REVOKED', title: 'A retake was cancelled',
          body: `The retake of "${exam.title}" was cancelled before it was used.`, data: { examId }, email: false,
        });
      }
      await log('EXAM_RETAKE_REVOKED', actor, ctx, examId, { retakeId, studentId: retake.studentId, was: retake.status });
      return null;
    },

    /** Every sitting a student has had of this exam, oldest first, with who asked for and approved each retake. For staff only. */
    async trail(actor: Actor, examId: string, studentId: string) {
      const exam = await accessible(actor, examId);
      const [past, current, requests, names] = await Promise.all([
        history.forStudent(examId, studentId), attempts.findByExamStudent(examId, studentId),
        retakes.forStudentExam(examId, studentId), students.nameMap([studentId]),
      ]);
      const staffNames = await staff.nameMap(requests.flatMap((r) => (r.decidedBy ? [r.requestedBy, r.decidedBy] : [r.requestedBy])));
      const byNewAttempt = new Map(requests.flatMap((r) => (r.newAttemptId ? [[r.newAttemptId, r] as const] : [])));
      const retakeOf = (attemptId: string) => {
        const r = byNewAttempt.get(attemptId);
        return r ? {
          id: r.id, reason: r.reason, requestedBy: r.requestedBy, requestedByName: staffNames.get(r.requestedBy) ?? '',
          approvedBy: r.decidedBy, approvedByName: r.decidedBy ? (staffNames.get(r.decidedBy) ?? '') : null,
          approvedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
        } : null;
      };
      const percent = (score: number | null, max: number): number | null => (score !== null && max > 0 ? round1((score / max) * 100) : null);

      const sittings = [
        ...past.map((h) => ({
          attemptNumber: h.attemptNumber, attemptId: h.attemptId, current: false, status: h.status, startedAt: h.startedAt.toISOString(),
          submittedAt: h.submittedAt ? h.submittedAt.toISOString() : null, score: h.score, maxScore: h.maxScore, percent: percent(h.score, h.maxScore),
          autoSubmitted: h.autoSubmitted, supersededAt: h.supersededAt.toISOString(), retake: retakeOf(h.attemptId),
        })),
        ...(current ? [{
          attemptNumber: current.attemptNumber, attemptId: current.id, current: true, status: current.status, startedAt: current.startedAt.toISOString(),
          submittedAt: current.submittedAt ? current.submittedAt.toISOString() : null, score: current.score, maxScore: current.maxScore,
          percent: percent(current.score, current.maxScore), autoSubmitted: current.autoSubmitted, supersededAt: null as string | null, retake: retakeOf(current.id),
        }] : []),
      ];
      return { examId, studentId, studentName: names.get(studentId) ?? '', attempts: sittings, requests: await viewsOf(requests, exam) };
    },

    /** Is a request waiting or approved but unused? Results cannot be released while one is. */
    hasOpen: (examId: string): Promise<boolean> => retakes.hasOpen(examId),
  };
}

export type RetakeService = ReturnType<typeof createRetakeService>;
