import { AppError } from '../../common/errors/AppError';
import type { ScopeService } from '../../common/scope/scope.service';
import { logger } from '../../common/utils/logger';
import { ROLES, type Role } from '../../config/constants';
import { withTransaction } from '../../config/db';
import type { enrolmentRepository } from '../academics/enrolment.repository';
import type { sessionRepository } from '../academics/session.repository';
import type { structureRepository } from '../academics/structure.repository';
import type { ExamScheduler } from '../../jobs/exam.jobs';
import type { linkRepository } from '../users/link.repository';
import type { studentRepository } from '../users/student.repository';
import { ATTEMPT_STATUS, type AttemptRecord, type attemptRepository } from './attempt.repository';
import { GRACE_MS } from './cbt.types';
import type { ExamRecord, examRepository } from './exam.repository';
import { cleanAnswer, gradeAttempt, shuffle, type PaperQuestion } from './grading';
import type { PaperCache } from './paper.cache';
import type { questionRepository } from './question.repository';

interface Actor { id: string; role: Role }

export interface AttemptServiceDeps {
  exams: Pick<typeof examRepository, 'findById' | 'listForArm'>;
  questions: Pick<typeof questionRepository, 'forExamWithKey'>;
  attempts: typeof attemptRepository;
  enrolments: Pick<typeof enrolmentRepository, 'forStudents'>;
  sessions: Pick<typeof sessionRepository, 'findCurrentSession'>;
  structure: Pick<typeof structureRepository, 'subjectsByIds' | 'armsByIds' | 'classesByIds'>;
  students: Pick<typeof studentRepository, 'nameMap'>;
  links: Pick<typeof linkRepository, 'activeStudentIdsOf'>;
  scope: Pick<ScopeService, 'assertCanAccessStudent'>;
  paper: PaperCache;
  scheduler: ExamScheduler;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const percentOf = (score: number, max: number): number | null => (max > 0 ? round1((score / max) * 100) : null);
const fail = (field: string, issue: string): AppError => new AppError('VALIDATION_ERROR', { details: [{ field, issue }] });

/** A score is visible once results are released, or straight after submitting when the exam is set to IMMEDIATE. */
export const resultsVisible = (exam: ExamRecord, attempt: AttemptRecord): boolean =>
  exam.resultsReleased || (exam.settings.resultRelease === 'IMMEDIATE' && attempt.status === ATTEMPT_STATUS.SUBMITTED);

export function createAttemptService(deps: AttemptServiceDeps) {
  const { exams, questions, attempts, enrolments, sessions, structure, students, links, scope, paper, scheduler } = deps;

  /** Builds the student's screen: questions in their own order, options in their own order, no answers. */
  function view(attempt: AttemptRecord, exam: ExamRecord, questionsInPaper: PaperQuestion[], now: Date) {
    const byId = new Map(questionsInPaper.map((q) => [q.id, q]));
    return {
      attemptId: attempt.id, examId: exam.id, title: exam.title, instructions: exam.instructions, durationMin: exam.durationMin,
      status: attempt.status, startedAt: attempt.startedAt.toISOString(), endsAt: attempt.endsAt.toISOString(),
      serverTime: now.toISOString(), remainingSeconds: Math.max(0, Math.floor((attempt.endsAt.getTime() - now.getTime()) / 1000)),
      answers: attempt.answers,
      questions: attempt.questionOrder.flatMap((id) => {
        const q = byId.get(id);
        if (!q) return [];
        const order = attempt.optionOrder[id];
        const options = q.options && order ? order.flatMap((key) => { const o = q.options?.find((x) => x.key === key); return o ? [o] : []; }) : q.options;
        return [{ id: q.id, type: q.type, text: q.text, marks: q.marks, options }];
      }),
    };
  }

  /** Closes an attempt and grades it, once, in one transaction. Safe to call any number of times. */
  async function finalize(attemptId: string, auto: boolean): Promise<AttemptRecord | null> {
    const attempt = await attempts.findById(attemptId);
    if (!attempt) return null;
    if (attempt.status === ATTEMPT_STATUS.SUBMITTED && attempt.graded) return attempt;

    const keyed = await questions.forExamWithKey(attempt.examId);
    const now = new Date();
    const at = now < attempt.endsAt ? now : attempt.endsAt;

    const done = await withTransaction(async (session) => {
      const claimed = await attempts.claimSubmission(attemptId, at, auto, session);
      const target = claimed ?? (await attempts.findById(attemptId, session));
      if (!target) return null;
      if (target.graded) return target;
      return attempts.applyGrade(attemptId, gradeAttempt(keyed, target.answers), session);
    });
    if (done) await scheduler.cancel(attemptId);
    return done;
  }

  const pastClock = (attempt: AttemptRecord, now: Date): boolean => now.getTime() > attempt.endsAt.getTime() + GRACE_MS;

  async function expire(attempt: AttemptRecord): Promise<never> {
    await finalize(attempt.id, true);
    throw new AppError('ATTEMPT_EXPIRED');
  }

  async function ownAttempt(actor: Actor, id: string): Promise<AttemptRecord> {
    const attempt = await attempts.findById(id);
    if (!attempt || attempt.studentId !== actor.id) throw new AppError('NOT_FOUND');
    return attempt;
  }

  async function mustExam(id: string): Promise<ExamRecord> {
    const exam = await exams.findById(id);
    if (!exam) throw new AppError('NOT_FOUND');
    return exam;
  }

  /** Checks answers against the paper and applies them atomically. */
  async function applyAnswers(attempt: AttemptRecord, exam: ExamRecord, input: Record<string, string | null>, now: Date): Promise<number> {
    const questionsInPaper = new Map((await paper.get(exam)).map((q) => [q.id, q]));
    const set: Record<string, string> = {};
    const unset: string[] = [];
    const inAttempt = new Set(attempt.questionOrder);

    for (const [questionId, raw] of Object.entries(input)) {
      const q = questionsInPaper.get(questionId);
      if (!q || !inAttempt.has(questionId)) throw fail(`answers.${questionId}`, 'Not a question of this exam');
      const cleaned = cleanAnswer(q, raw);
      if (cleaned === undefined) throw fail(`answers.${questionId}`, 'Not a valid answer to this question');
      if (cleaned === null) unset.push(questionId);
      else set[questionId] = cleaned;
    }

    const saved = await attempts.saveAnswers(attempt.id, attempt.studentId, set, unset, new Date(now.getTime() - GRACE_MS));
    if (!saved) {
      const latest = await attempts.findById(attempt.id);
      if (latest?.status === ATTEMPT_STATUS.SUBMITTED) throw new AppError('ATTEMPT_ALREADY_SUBMITTED');
      if (latest) await expire(latest);
      throw new AppError('NOT_FOUND');
    }
    return Object.keys(set).length + unset.length;
  }

  return {
    /** Runs when an attempt's clock ends (a delayed job). */
    async autoSubmit(attemptId: string): Promise<void> {
      const attempt = await attempts.findById(attemptId);
      if (!attempt || (attempt.status === ATTEMPT_STATUS.SUBMITTED && attempt.graded)) return;
      if (attempt.status === ATTEMPT_STATUS.IN_PROGRESS && attempt.endsAt.getTime() > Date.now()) {
        await scheduler.scheduleAutoSubmit(attemptId, attempt.endsAt); // too early: try again at the right time
        return;
      }
      await finalize(attemptId, true);
    },

    /** Runs every minute: closes anything overdue and grades anything left half-finished. */
    async sweep(): Promise<void> {
      const overdue = await attempts.findOverdueIds(new Date(Date.now() - GRACE_MS), 200);
      const ungraded = await attempts.findUngradedIds(200);
      for (const id of new Set([...overdue, ...ungraded])) {
        try { await finalize(id, true); } catch (err) { logger.error({ err, attemptId: id }, 'sweep could not finalize an attempt'); }
      }
    },

    /** For result release: closes every overdue attempt of one exam. */
    async finalizeOverdueFor(examId: string): Promise<number> {
      const ids = await attempts.findOverdueForExam(examId, new Date(Date.now() - GRACE_MS));
      for (const id of ids) await finalize(id, true);
      return ids.length;
    },

    time: (): { serverTime: string } => ({ serverTime: new Date().toISOString() }),

    /** Starts the exam, or resumes it if it is already running. */
    async start(actor: Actor, examId: string) {
      const exam = await exams.findById(examId);
      if (!exam || exam.status !== 'PUBLISHED') throw new AppError('NOT_FOUND');
      const armId = (await enrolments.forStudents([actor.id], exam.sessionId)).get(actor.id)?.classArmId;
      if (!armId || !exam.classArmIds.includes(armId)) throw new AppError('NOT_FOUND');

      const now = new Date();
      const resume = async (attempt: AttemptRecord) => {
        if (attempt.status === ATTEMPT_STATUS.SUBMITTED) throw new AppError('ATTEMPT_ALREADY_SUBMITTED');
        if (pastClock(attempt, now)) await expire(attempt);
        return view(attempt, exam, await paper.get(exam), now);
      };

      const existing = await attempts.findByExamStudent(examId, actor.id);
      if (existing) return resume(existing);

      if (now < exam.windowStart || now >= exam.windowEnd || exam.questionCount === 0) throw new AppError('EXAM_NOT_OPEN');

      const questionsInPaper = await paper.get(exam);
      if (questionsInPaper.length === 0) throw new AppError('EXAM_NOT_OPEN');
      const ids = questionsInPaper.map((q) => q.id);
      const optionOrder: Record<string, string[]> = {};
      if (exam.settings.shuffleOptions) {
        for (const q of questionsInPaper) if (q.type === 'MCQ' && q.options) optionOrder[q.id] = shuffle(q.options.map((o) => o.key));
      }

      const endsAt = new Date(Math.min(now.getTime() + exam.durationMin * 60_000, exam.windowEnd.getTime()));
      const created = await attempts.create({
        examId, studentId: actor.id, startedAt: now, endsAt,
        questionOrder: exam.settings.shuffleQuestions ? shuffle(ids) : ids, optionOrder,
        maxScore: round1(questionsInPaper.reduce((s, q) => s + q.marks, 0)),
      });
      if (!created) {
        const raced = await attempts.findByExamStudent(examId, actor.id); // a double click started it a moment ago
        if (raced) return resume(raced);
        throw new AppError('CONFLICT');
      }

      await scheduler.scheduleAutoSubmit(created.id, created.endsAt);
      return view(created, exam, questionsInPaper, now);
    },

    /** After a refresh: the same paper, the saved answers and the time that is left. */
    async resume(actor: Actor, attemptId: string) {
      const attempt = await ownAttempt(actor, attemptId);
      const exam = await mustExam(attempt.examId);
      const now = new Date();
      if (attempt.status === ATTEMPT_STATUS.SUBMITTED) throw new AppError('ATTEMPT_ALREADY_SUBMITTED');
      if (pastClock(attempt, now)) await expire(attempt);
      return view(attempt, exam, await paper.get(exam), now);
    },

    async saveAnswers(actor: Actor, attemptId: string, answers: Record<string, string | null>) {
      const attempt = await ownAttempt(actor, attemptId);
      const now = new Date();
      if (attempt.status === ATTEMPT_STATUS.SUBMITTED) throw new AppError('ATTEMPT_ALREADY_SUBMITTED');
      if (pastClock(attempt, now)) await expire(attempt);

      const saved = await applyAnswers(attempt, await mustExam(attempt.examId), answers, now);
      return { saved, serverTime: now.toISOString(), remainingSeconds: Math.max(0, Math.floor((attempt.endsAt.getTime() - now.getTime()) / 1000)) };
    },

    /** Safe to repeat. Optional final answers are saved first, if the clock allows. */
    async submit(actor: Actor, attemptId: string, answers?: Record<string, string | null>) {
      const attempt = await ownAttempt(actor, attemptId);
      const exam = await mustExam(attempt.examId);
      const now = new Date();

      let done = attempt;
      if (attempt.status === ATTEMPT_STATUS.IN_PROGRESS) {
        if (pastClock(attempt, now)) await expire(attempt);
        if (answers && Object.keys(answers).length > 0) await applyAnswers(attempt, exam, answers, now);
        done = (await finalize(attempt.id, false)) ?? attempt;
      } else if (!attempt.graded) {
        done = (await finalize(attempt.id, true)) ?? attempt;
      }

      const visible = done.graded && resultsVisible(exam, done);
      return {
        attemptId: done.id, status: done.status, submittedAt: done.submittedAt ? done.submittedAt.toISOString() : null,
        resultAvailable: visible, score: visible ? done.score : null, maxScore: visible ? done.maxScore : null,
        percent: visible && done.score !== null ? percentOf(done.score, done.maxScore) : null,
      };
    },

    async result(actor: Actor, attemptId: string) {
      let attempt = await ownAttempt(actor, attemptId);
      const exam = await mustExam(attempt.examId);
      const now = new Date();

      if (attempt.status === ATTEMPT_STATUS.IN_PROGRESS) {
        if (!pastClock(attempt, now)) throw new AppError('CONFLICT', { message: 'Submit the exam first' });
        attempt = (await finalize(attempt.id, true)) ?? attempt;
      } else if (!attempt.graded) {
        attempt = (await finalize(attempt.id, true)) ?? attempt;
      }
      if (!attempt.graded || attempt.score === null) throw new AppError('CONFLICT', { message: 'Your result is still being calculated. Try again in a moment.' });
      if (!resultsVisible(exam, attempt)) throw new AppError('CONFLICT', { message: 'Results have not been released yet' });

      const percent = percentOf(attempt.score, attempt.maxScore);
      const base = {
        attemptId: attempt.id, examId: exam.id, title: exam.title, score: attempt.score, maxScore: attempt.maxScore, percent,
        passed: percent !== null && percent >= exam.settings.passMarkPercent, passMarkPercent: exam.settings.passMarkPercent,
        correctCount: attempt.correctCount ?? 0, questionCount: attempt.questionOrder.length,
        submittedAt: attempt.submittedAt ? attempt.submittedAt.toISOString() : null, autoSubmitted: attempt.autoSubmitted,
      };

      // The answer review exists only after release, which needs the window to have closed, so nobody can leak answers to the room.
      if (!exam.resultsReleased || !exam.settings.showAnswers) return { ...base, review: null };

      const keyed = new Map((await questions.forExamWithKey(exam.id)).map((q) => [q.id, q]));
      const review = attempt.questionOrder.flatMap((id) => {
        const q = keyed.get(id);
        if (!q) return [];
        const order = attempt.optionOrder[id];
        const options = q.options && order ? order.flatMap((key) => { const o = q.options?.find((x) => x.key === key); return o ? [o] : []; }) : q.options;
        const yours = attempt.answers[id] ?? null;
        const correct = yours !== null && gradeAttempt([q], { [id]: yours }).score > 0;
        return [{
          questionId: id, type: q.type, text: q.text, options, yourAnswer: yours, correctAnswer: q.correctAnswer,
          correct, marks: q.marks, marksAwarded: correct ? q.marks : 0, explanation: q.explanation,
        }];
      });
      return { ...base, review };
    },

    /** The student's exams this session: upcoming, open, in progress, completed or missed. */
    async myExams(actor: Actor) {
      const current = await sessions.findCurrentSession();
      if (!current) return [];
      const armId = (await enrolments.forStudents([actor.id], current.id)).get(actor.id)?.classArmId;
      if (!armId) return [];

      const list = await exams.listForArm(armId, current.id, new Date(Date.now() - 60 * 86_400_000));
      const [byExam, subjects] = await Promise.all([attempts.forStudentExams(actor.id, list.map((e) => e.id)), structure.subjectsByIds(list.map((e) => e.subjectId))]);
      const now = new Date();

      return list.map((exam) => {
        const a = byExam.get(exam.id);
        const state = a
          ? a.status === ATTEMPT_STATUS.IN_PROGRESS && a.endsAt > now ? 'IN_PROGRESS' : 'COMPLETED'
          : now < exam.windowStart ? 'UPCOMING' : now < exam.windowEnd ? 'OPEN' : 'MISSED';
        const visible = a && a.graded && a.score !== null && resultsVisible(exam, a);
        const percent = visible && a.score !== null ? percentOf(a.score, a.maxScore) : null;
        return {
          id: exam.id, title: exam.title, subjectName: subjects.get(exam.subjectId)?.name ?? '', type: exam.type,
          durationMin: exam.durationMin, windowStart: exam.windowStart.toISOString(), windowEnd: exam.windowEnd.toISOString(),
          instructions: exam.instructions, questionCount: exam.questionCount, state,
          attempt: a ? { id: a.id, status: a.status, endsAt: a.endsAt.toISOString(), submittedAt: a.submittedAt ? a.submittedAt.toISOString() : null } : null,
          result: visible && a.score !== null ? { score: a.score, maxScore: a.maxScore, percent, passed: percent !== null && percent >= exam.settings.passMarkPercent } : null,
        };
      });
    },

    /** Read-only schedule for a student, or for a parent's linked children. */
    async schedule(actor: Actor, studentId?: string) {
      const current = await sessions.findCurrentSession();
      if (!current) return [];

      let studentIds: string[];
      if (actor.role === ROLES.STUDENT) studentIds = [actor.id];
      else if (studentId) { await scope.assertCanAccessStudent(actor, studentId); studentIds = [studentId]; }
      else studentIds = await links.activeStudentIdsOf(actor.id);

      const enrolled = await enrolments.forStudents(studentIds, current.id);
      const armIds = [...new Set([...enrolled.values()].map((e) => e.classArmId))];
      const since = new Date(Date.now() - 7 * 86_400_000);
      const byArm = new Map((await Promise.all(armIds.map(async (id) => [id, await exams.listForArm(id, current.id, since)] as const))));

      const [names, arms] = await Promise.all([students.nameMap(studentIds), structure.armsByIds(armIds)]);
      const classes = await structure.classesByIds([...arms.values()].map((a) => a.classId));
      const subjects = await structure.subjectsByIds([...byArm.values()].flat().map((e) => e.subjectId));

      return studentIds.flatMap((id) => {
        const armId = enrolled.get(id)?.classArmId;
        const arm = armId ? arms.get(armId) : undefined;
        const className = arm ? `${classes.get(arm.classId)?.name ?? ''} ${arm.name}`.trim() : '';
        return (armId ? (byArm.get(armId) ?? []) : []).map((exam) => ({
          examId: exam.id, title: exam.title, subjectName: subjects.get(exam.subjectId)?.name ?? '', type: exam.type,
          windowStart: exam.windowStart.toISOString(), windowEnd: exam.windowEnd.toISOString(), durationMin: exam.durationMin,
          studentId: id, studentName: names.get(id) ?? '', classArmName: className,
        }));
      }).sort((a, b) => a.windowStart.localeCompare(b.windowStart));
    },
  };
}

export type AttemptService = ReturnType<typeof createAttemptService>;