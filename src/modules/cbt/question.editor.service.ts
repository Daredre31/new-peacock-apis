import { AppError } from '../../common/errors/AppError';
import { withTransaction } from '../../config/db';
import { recordSafely, type AuditPort } from '../audit/audit.port';
import { EXAM_STATUS, MAX_QUESTIONS } from './cbt.types';
import type { ExamRecord, examRepository } from './exam.repository';
import type { StoredQuestion } from './grading';
import type { PaperCache } from './paper.cache';
import { poolIssue } from './pool';
import type { ImageRecord } from './question.image.repository';
import type { QuestionToSave, questionRepository } from './question.repository';
import { buildQuestion, type BuiltQuestion, type QuestionInput, type QuestionIssue } from './question.rules';

interface Actor { id: string }
interface Context { ip: string; requestId: string }

/** What the exam holds after a change. `problem` is a heads-up, not a block: it is only enforced when the exam is submitted. */
export interface ExamSummary { questionCount: number; maxScore: number; problem: QuestionIssue | null }
export interface StaffQuestion {
  id: string; order: number; type: string; text: string; options: { key: string; text: string }[] | null; correctAnswer: string | string[];
  marks: number; topic: string | null; difficulty: string; explanation: string | null;
  imageFileName: string | null; imageUrl: string | null; imageWidth: number | null; imageHeight: number | null;
}
export type QuestionPatch = Partial<QuestionInput>;

const toStaff = (q: StoredQuestion): StaffQuestion => ({
  id: q.id, order: q.order, type: q.type, text: q.text, options: q.options, correctAnswer: q.correctAnswer, marks: q.marks,
  topic: q.topic, difficulty: q.difficulty, explanation: q.explanation,
  imageFileName: q.imageFileName ?? null, imageUrl: q.imageUrl ?? null, imageWidth: q.imageWidth ?? null, imageHeight: q.imageHeight ?? null,
});

const invalid = (issues: readonly QuestionIssue[]): AppError =>
  new AppError('VALIDATION_ERROR', { details: issues.map((i) => ({ field: i.field, issue: i.issue })) });
const isDuplicateKey = (err: unknown): boolean => typeof err === 'object' && err !== null && 'code' in err && err.code === 11000;
const duplicate = (): AppError => new AppError('CONFLICT', { details: [{ field: 'text', issue: 'This exam already has an identical question' }] });

export function createQuestionEditorService(deps: {
  questions: Pick<typeof questionRepository, 'findOne' | 'insertOne' | 'replaceOne' | 'deleteOne' | 'totals' | 'distinctMarks'>;
  exams: Pick<typeof examRepository, 'findById' | 'setQuestionStats'>;
  pictures: { byName(examId: string): Promise<Map<string, ImageRecord>> };
  paper: PaperCache;
  audit: AuditPort;
}) {
  const { questions, exams, pictures, paper, audit } = deps;

  /** The teacher's own exam, and only while questions can still change: a draft, or one an admin sent back. */
  async function editableExam(actor: Actor, examId: string): Promise<ExamRecord> {
    const exam = await exams.findById(examId);
    if (!exam || exam.teacherId !== actor.id) throw new AppError('NOT_FOUND');
    if (exam.status !== EXAM_STATUS.DRAFT && exam.status !== EXAM_STATUS.REJECTED) {
      throw new AppError('CONFLICT', { message: 'Only a draft or a rejected exam can have its questions changed' });
    }
    return exam;
  }

  /** Attaches the picture the question names, which must already be uploaded to this exam. */
  async function withPicture(examId: string, built: BuiltQuestion, keep: StoredQuestion | null): Promise<QuestionToSave> {
    const { imageFile, ...rest } = built;
    let image: QuestionToSave['image'] = null;
    if (imageFile) {
      if (keep && keep.imageFileName === imageFile && keep.imageUrl) {
        image = { fileName: imageFile, url: keep.imageUrl, width: keep.imageWidth ?? 0, height: keep.imageHeight ?? 0 };
      } else {
        const found = (await pictures.byName(examId)).get(imageFile);
        if (!found) throw invalid([{ field: 'imageFileName', issue: `No picture named "${imageFile}" has been uploaded to this exam. Upload it first` }]);
        image = { fileName: found.fileName, url: found.url, width: found.width, height: found.height };
      }
    }
    return { ...rest, image };
  }

  /** Writes the totals from the questions that are really there. A false means the exam stopped being editable: undo everything. */
  async function syncTotals(examId: string, tx: Parameters<typeof questions.totals>[1]): Promise<{ count: number; maxScore: number }> {
    const t = await questions.totals(examId, tx);
    if (!(await exams.setQuestionStats(examId, t.count, t.maxScore, tx))) {
      throw new AppError('CONFLICT', { message: 'This exam was submitted while you were editing it' });
    }
    return t;
  }

  /** Mixed marks matter once students are given only some of the questions. Say so now rather than at submission. */
  async function summary(exam: ExamRecord, t: { count: number; maxScore: number }): Promise<ExamSummary> {
    const issue = poolIssue(exam.settings.questionsPerStudent, t.count, await questions.distinctMarks(exam.id));
    return { questionCount: t.count, maxScore: t.maxScore, problem: issue && issue.field === 'marks' ? issue : null };
  }

  return {
    /** Adds one question at the end of the exam. */
    async add(actor: Actor, examId: string, input: QuestionInput, ctx: Context): Promise<{ question: StaffQuestion; exam: ExamSummary }> {
      const exam = await editableExam(actor, examId);
      const built = buildQuestion(input);
      if (!built.ok) throw invalid(built.issues);
      const toSave = await withPicture(examId, built.value, null);

      let saved: StoredQuestion; let totals: { count: number; maxScore: number };
      try {
        ({ saved, totals } = await withTransaction(async (tx) => {
          if ((await questions.totals(examId, tx)).count >= MAX_QUESTIONS) {
            throw new AppError('CONFLICT', { details: [{ field: 'text', issue: `An exam can have at most ${MAX_QUESTIONS} questions` }] });
          }
          const inserted = await questions.insertOne(examId, toSave, tx);
          return { saved: inserted, totals: await syncTotals(examId, tx) };
        }));
      } catch (err) {
        throw isDuplicateKey(err) ? duplicate() : err;
      }

      await paper.invalidate(examId);
      await recordSafely(audit, {
        action: 'EXAM_QUESTION_ADDED', actorId: actor.id, entityType: 'exam', entityId: examId, ip: ctx.ip, requestId: ctx.requestId,
        metadata: { questionId: saved.id, type: saved.type, marks: saved.marks, text: saved.text.slice(0, 80) },
      });
      return { question: toStaff(saved), exam: await summary(exam, totals) };
    },

    /** Changes any of a question's fields. Only what is sent changes, and the result must still be a valid question. */
    async update(actor: Actor, examId: string, questionId: string, patch: QuestionPatch, ctx: Context): Promise<{ question: StaffQuestion; exam: ExamSummary }> {
      const exam = await editableExam(actor, examId);
      const existing = await questions.findOne(examId, questionId);
      if (!existing) throw new AppError('NOT_FOUND');
      const changed = Object.entries(patch).filter(([, v]) => v !== undefined).map(([k]) => k);
      if (changed.length === 0) throw invalid([{ field: 'body', issue: 'Nothing to update' }]);

      const type = patch.type ?? existing.type;
      const candidate: QuestionInput = {
        type,
        text: patch.text ?? existing.text,
        // Moving to a type without options drops them, so a teacher need not send options: null as well.
        options: patch.options !== undefined ? patch.options : (type === 'MCQ' ? existing.options?.map((o) => o.text) ?? null : null),
        correctAnswer: patch.correctAnswer ?? existing.correctAnswer,
        marks: patch.marks ?? existing.marks,
        topic: patch.topic !== undefined ? patch.topic : existing.topic,
        difficulty: patch.difficulty ?? existing.difficulty,
        explanation: patch.explanation !== undefined ? patch.explanation : existing.explanation,
        imageFileName: patch.imageFileName !== undefined ? patch.imageFileName : existing.imageFileName ?? null,
      };
      const built = buildQuestion(candidate);
      if (!built.ok) throw invalid(built.issues);
      const toSave = await withPicture(examId, built.value, existing);

      let saved: StoredQuestion | null; let totals: { count: number; maxScore: number };
      try {
        ({ saved, totals } = await withTransaction(async (tx) => {
          const replaced = await questions.replaceOne(examId, questionId, toSave, tx);
          if (!replaced) throw new AppError('NOT_FOUND');
          return { saved: replaced, totals: await syncTotals(examId, tx) };
        }));
      } catch (err) {
        throw isDuplicateKey(err) ? duplicate() : err;
      }
      if (!saved) throw new AppError('NOT_FOUND');

      await paper.invalidate(examId);
      await recordSafely(audit, {
        action: 'EXAM_QUESTION_UPDATED', actorId: actor.id, entityType: 'exam', entityId: examId, ip: ctx.ip, requestId: ctx.requestId,
        metadata: { questionId, fields: changed, before: { text: existing.text.slice(0, 80), marks: existing.marks }, after: { text: saved.text.slice(0, 80), marks: saved.marks } },
      });
      return { question: toStaff(saved), exam: await summary(exam, totals) };
    },

    /** Removes one question. The ones after it move up, so the numbering has no gap. */
    async remove(actor: Actor, examId: string, questionId: string, ctx: Context): Promise<{ exam: ExamSummary }> {
      const exam = await editableExam(actor, examId);
      const existing = await questions.findOne(examId, questionId);
      if (!existing) throw new AppError('NOT_FOUND');

      const totals = await withTransaction(async (tx) => {
        if (!(await questions.deleteOne(examId, questionId, tx))) throw new AppError('NOT_FOUND');
        return syncTotals(examId, tx);
      });

      await paper.invalidate(examId);
      await recordSafely(audit, {
        action: 'EXAM_QUESTION_DELETED', actorId: actor.id, entityType: 'exam', entityId: examId, ip: ctx.ip, requestId: ctx.requestId,
        metadata: { questionId, type: existing.type, marks: existing.marks, text: existing.text.slice(0, 80) },
      });
      return { exam: await summary(exam, totals) };
    },
  };
}

export type QuestionEditorService = ReturnType<typeof createQuestionEditorService>;
