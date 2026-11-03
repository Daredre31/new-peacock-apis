import mongoose, { type ClientSession, type Model, type Types } from 'mongoose';
import { DIFFICULTIES, QUESTION_TYPES, type Difficulty, type QuestionType } from './cbt.types';
import type { PaperQuestion, StoredQuestion } from './grading';

interface QuestionDocument {
  examId: Types.ObjectId; importBatchId: Types.ObjectId; order: number; type: QuestionType; text: string;
  options: { key: string; text: string }[]; correctAnswer: string | string[]; marks: number;
  topic: string | null; difficulty: Difficulty; explanation: string | null; hash: string;
}
type Row = QuestionDocument & { _id: Types.ObjectId };

const questionSchema = new mongoose.Schema<QuestionDocument>(
  {
    examId: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', required: true },
    importBatchId: { type: mongoose.Schema.Types.ObjectId, required: true },
    order: { type: Number, required: true },
    type: { type: String, enum: QUESTION_TYPES, required: true },
    text: { type: String, required: true, maxlength: 1000 },
    options: { type: [{ key: String, text: String, _id: false }], default: [] },
    correctAnswer: { type: mongoose.Schema.Types.Mixed, required: true },
    marks: { type: Number, required: true },
    topic: { type: String, default: null }, difficulty: { type: String, enum: DIFFICULTIES, default: 'MEDIUM' },
    explanation: { type: String, default: null }, hash: { type: String, required: true },
  },
  { versionKey: false, minimize: false },
);
questionSchema.index({ examId: 1, order: 1 });
questionSchema.index({ examId: 1, hash: 1 }, { unique: true });

interface BatchDocument { examId: Types.ObjectId; ownerId: Types.ObjectId; kind: 'QUESTIONS'; fileName: string; rowCount: number; status: 'CONFIRMED'; createdAt: Date }
const batchSchema = new mongoose.Schema<BatchDocument>(
  {
    examId: { type: mongoose.Schema.Types.ObjectId, required: true },
    ownerId: { type: mongoose.Schema.Types.ObjectId, required: true },
    kind: { type: String, default: 'QUESTIONS' }, fileName: { type: String, maxlength: 200 },
    rowCount: Number, status: { type: String, default: 'CONFIRMED' },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
batchSchema.index({ examId: 1 });

const QuestionModel: Model<QuestionDocument> =
  (mongoose.models.Question as Model<QuestionDocument> | undefined) ?? mongoose.model<QuestionDocument>('Question', questionSchema);
const BatchModel: Model<BatchDocument> =
  (mongoose.models.ImportBatch as Model<BatchDocument> | undefined) ?? mongoose.model<BatchDocument>('ImportBatch', batchSchema);

export type NewQuestion = Omit<StoredQuestion, 'id' | 'order'> & { hash: string };

const toStored = (r: Row): StoredQuestion => ({
  id: r._id.toString(), order: r.order, type: r.type, text: r.text, options: r.options.length > 0 ? r.options : null,
  correctAnswer: r.correctAnswer, marks: r.marks, topic: r.topic ?? null, difficulty: r.difficulty, explanation: r.explanation ?? null,
});

/** Replaces the exam's whole question set with one new batch. Runs inside the caller's transaction. */
async function replaceAll(examId: string, ownerId: string, fileName: string, questions: NewQuestion[], session: ClientSession) {
  await QuestionModel.deleteMany({ examId }, { session });
  await BatchModel.deleteMany({ examId }, { session });
  const [batch] = await BatchModel.create([{ examId, ownerId, fileName, rowCount: questions.length }], { session });
  if (!batch) throw new Error('Import batch was not created');

  await QuestionModel.insertMany(
    questions.map((q, order) => ({
      examId, importBatchId: batch._id, order, type: q.type, text: q.text, options: q.options ?? [],
      correctAnswer: q.correctAnswer, marks: q.marks, topic: q.topic, difficulty: q.difficulty, explanation: q.explanation, hash: q.hash,
    })),
    { session },
  );
  return { count: questions.length, maxScore: Math.round(questions.reduce((s, q) => s + q.marks, 0) * 10) / 10 };
}

async function forExamWithKey(examId: string): Promise<StoredQuestion[]> {
  const rows = await QuestionModel.find({ examId }).sort({ order: 1 }).lean<Row[]>();
  return rows.map(toStored);
}

/** The paper as students see it: no correct answers, no explanations. */
async function paperOf(examId: string): Promise<PaperQuestion[]> {
  return (await forExamWithKey(examId)).map((q) => ({ id: q.id, type: q.type, text: q.text, options: q.options, marks: q.marks }));
}

async function removeForExam(examId: string): Promise<void> {
  await QuestionModel.deleteMany({ examId });
  await BatchModel.deleteMany({ examId });
}

export const questionRepository = { replaceAll, forExamWithKey, paperOf, removeForExam };