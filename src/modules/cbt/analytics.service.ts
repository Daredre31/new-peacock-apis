import { AppError } from '../../common/errors/AppError';
import { ROLES, type Role } from '../../config/constants';
import type { enrolmentRepository } from '../academics/enrolment.repository';
import type { studentRepository } from '../users/student.repository';
import { ATTEMPT_STATUS, type attemptRepository } from './attempt.repository';
import type { examRepository } from './exam.repository';
import { isCorrect } from './grading';
import type { questionRepository } from './question.repository';

interface Actor { id: string; role: Role }
const round1 = (n: number): number => Math.round(n * 10) / 10;
const MAX_LISTED = 500;

export function createAnalyticsService(deps: {
  exams: Pick<typeof examRepository, 'findById'>;
  questions: Pick<typeof questionRepository, 'forExamWithKey'>;
  attempts: Pick<typeof attemptRepository, 'allForExam' | 'listForExam'>;
  enrolments: Pick<typeof enrolmentRepository, 'studentIdsInArms'>;
  students: Pick<typeof studentRepository, 'profileMap'>;
}) {
  const { exams, questions, attempts, enrolments, students } = deps;

  async function accessible(actor: Actor, id: string) {
    const exam = await exams.findById(id);
    if (!exam) throw new AppError('NOT_FOUND');
    const staff = actor.role === ROLES.ADMIN || actor.role === ROLES.SUPER_ADMIN;
    if (!staff && !(actor.role === ROLES.TEACHER && exam.teacherId === actor.id)) throw new AppError('NOT_FOUND');
    return exam;
  }

  return {
    async analytics(actor: Actor, examId: string) {
      const exam = await accessible(actor, examId);
      const [paper, all, enrolled] = await Promise.all([questions.forExamWithKey(examId), attempts.allForExam(examId), enrolments.studentIdsInArms(exam.classArmIds, exam.sessionId)]);

      const done = all.filter((a) => a.status === ATTEMPT_STATUS.SUBMITTED && a.graded && a.score !== null);
      const percents = done.map((a) => (a.maxScore > 0 && a.score !== null ? (a.score / a.maxScore) * 100 : 0));
      const average = (xs: number[]): number | null => (xs.length === 0 ? null : round1(xs.reduce((s, x) => s + x, 0) / xs.length));

      const buckets = Array.from({ length: 10 }, (_, i) => ({ from: i * 10, to: i === 9 ? 100 : i * 10 + 9.9, count: 0 }));
      for (const p of percents) {
        const bucket = buckets[Math.min(9, Math.floor(p / 10))];
        if (bucket) bucket.count += 1;
      }

      // How often each question was answered correctly, worked out from the saved answers.
      const stats = paper.map((q) => {
        const correct = done.filter((a) => isCorrect(q, a.answers[q.id])).length;
        const answered = done.filter((a) => a.answers[q.id] !== undefined).length;
        return { questionId: q.id, order: q.order + 1, text: q.text.slice(0, 200), type: q.type, topic: q.topic, difficulty: q.difficulty, marks: q.marks, answered, correct, percentCorrect: done.length === 0 ? null : round1((correct / done.length) * 100) };
      });
      const hardest = stats.filter((s) => s.percentCorrect !== null).sort((a, b) => (a.percentCorrect ?? 0) - (b.percentCorrect ?? 0)).slice(0, 10);

      const started = new Set(all.map((a) => a.studentId));
      const missing = enrolled.filter((id) => !started.has(id));
      const profiles = await students.profileMap(missing.slice(0, MAX_LISTED));

      return {
        examId, title: exam.title, final: exam.windowEnd <= new Date(),
        enrolled: enrolled.length, submitted: done.length,
        inProgress: all.filter((a) => a.status === ATTEMPT_STATUS.IN_PROGRESS).length, notStarted: missing.length,
        averageScore: average(done.flatMap((a) => (a.score === null ? [] : [a.score]))), averagePercent: average(percents),
        highestPercent: percents.length === 0 ? null : round1(Math.max(...percents)), lowestPercent: percents.length === 0 ? null : round1(Math.min(...percents)),
        passMarkPercent: exam.settings.passMarkPercent,
        passRate: percents.length === 0 ? null : round1((percents.filter((p) => p >= exam.settings.passMarkPercent).length / percents.length) * 100),
        distribution: buckets, hardestQuestions: hardest, questions: stats,
        notTaken: missing.slice(0, MAX_LISTED).map((id) => ({ studentId: id, name: profiles.get(id)?.name ?? '', admissionNo: profiles.get(id)?.admissionNo ?? '' })),
      };
    },

    /** Live monitoring: who started, how far they have got, who has finished. */
    async attemptsOf(actor: Actor, examId: string, input: { page: number; limit: number }) {
      await accessible(actor, examId);
      const { items, total } = await attempts.listForExam(examId, input);
      const profiles = await students.profileMap(items.map((a) => a.studentId));
      return {
        total,
        items: items.map((a) => ({
          attemptId: a.id, studentId: a.studentId, studentName: profiles.get(a.studentId)?.name ?? '', admissionNo: profiles.get(a.studentId)?.admissionNo ?? '',
          status: a.status, startedAt: a.startedAt.toISOString(), endsAt: a.endsAt.toISOString(), submittedAt: a.submittedAt ? a.submittedAt.toISOString() : null,
          autoSubmitted: a.autoSubmitted, answered: Object.keys(a.answers).length, questions: a.questionOrder.length, score: a.score, maxScore: a.maxScore,
        })),
      };
    },
  };
}

export type AnalyticsService = ReturnType<typeof createAnalyticsService>;