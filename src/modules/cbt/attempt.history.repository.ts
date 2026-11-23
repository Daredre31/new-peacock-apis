import mongoose, { type ClientSession, type Model, type Types } from 'mongoose';
import type { AttemptRecord, AttemptStatus } from './attempt.repository';

/**
 * Earlier sittings of an exam, kept when an approved retake replaces them. Only ever added to and read, never changed.
 * The live attempt collection holds each student's current sitting, so results, analytics and parents only ever see that one.
 */
interface HistoryDocument {
  examId: Types.ObjectId; studentId: Types.ObjectId; attemptId: Types.ObjectId; attemptNumber: number;
  startedAt: Date; endsAt: Date; status: AttemptStatus; questionOrder: Types.ObjectId[];
  optionOrder: Record<string, string[]>; answers: Record<string, string>;
  maxScore: number; score: number | null; correctCount: number | null; graded: boolean;
  submittedAt: Date | null; autoSubmitted: boolean;
  supersededAt: Date; retakeId: Types.ObjectId;
}
type Row = HistoryDocument & { _id: Types.ObjectId };

const schema = new mongoose.Schema<HistoryDocument>(
  {
    examId: { type: mongoose.Schema.Types.ObjectId, required: true },
    studentId: { type: mongoose.Schema.Types.ObjectId, required: true },
    attemptId: { type: mongoose.Schema.Types.ObjectId, required: true },
    attemptNumber: { type: Number, required: true },
    startedAt: { type: Date, required: true }, endsAt: { type: Date, required: true },
    status: { type: String, required: true },
    questionOrder: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    optionOrder: { type: mongoose.Schema.Types.Mixed, default: {} },
    answers: { type: mongoose.Schema.Types.Mixed, default: {} },
    maxScore: { type: Number, required: true },
    score: { type: Number, default: null }, correctCount: { type: Number, default: null }, graded: { type: Boolean, default: false },
    submittedAt: { type: Date, default: null }, autoSubmitted: { type: Boolean, default: false },
    supersededAt: { type: Date, required: true },
    retakeId: { type: mongoose.Schema.Types.ObjectId, required: true },
  },
  { collection: 'attempt_history', timestamps: false, versionKey: false, minimize: false },
);
schema.index({ examId: 1, studentId: 1, attemptNumber: 1 }, { unique: true });

const HistoryModel: Model<HistoryDocument> =
  (mongoose.models.AttemptHistory as Model<HistoryDocument> | undefined) ?? mongoose.model<HistoryDocument>('AttemptHistory', schema);

export interface HistoryRecord {
  attemptId: string; attemptNumber: number; status: AttemptStatus; startedAt: Date; submittedAt: Date | null;
  score: number | null; maxScore: number; autoSubmitted: boolean; supersededAt: Date; retakeId: string;
}

/** Files an attempt in the history. Runs inside the retake's transaction. */
async function archive(attempt: AttemptRecord, meta: { retakeId: string; supersededAt: Date }, session: ClientSession): Promise<void> {
  await HistoryModel.create([{
    examId: attempt.examId, studentId: attempt.studentId, attemptId: attempt.id, attemptNumber: attempt.attemptNumber,
    startedAt: attempt.startedAt, endsAt: attempt.endsAt, status: attempt.status, questionOrder: attempt.questionOrder,
    optionOrder: attempt.optionOrder, answers: attempt.answers, maxScore: attempt.maxScore, score: attempt.score,
    correctCount: attempt.correctCount, graded: attempt.graded, submittedAt: attempt.submittedAt, autoSubmitted: attempt.autoSubmitted,
    supersededAt: meta.supersededAt, retakeId: meta.retakeId,
  }], { session });
}

async function forStudent(examId: string, studentId: string): Promise<HistoryRecord[]> {
  if (!/^[a-f0-9]{24}$/.test(examId) || !/^[a-f0-9]{24}$/.test(studentId)) return [];
  const rows = await HistoryModel.find({ examId, studentId }).sort({ attemptNumber: 1 }).lean<Row[]>();
  return rows.map((r) => ({
    attemptId: r.attemptId.toString(), attemptNumber: r.attemptNumber, status: r.status, startedAt: r.startedAt, submittedAt: r.submittedAt ?? null,
    score: r.score ?? null, maxScore: r.maxScore, autoSubmitted: r.autoSubmitted, supersededAt: r.supersededAt, retakeId: r.retakeId.toString(),
  }));
}

export const attemptHistoryRepository = { archive, forStudent };
