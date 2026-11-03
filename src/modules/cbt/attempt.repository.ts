import mongoose, { type ClientSession, type Model, type Types } from 'mongoose';
import { isDuplicateKeyError } from '../../common/utils/mongoErrors';
import { skipOf } from '../../common/utils/pagination';

export const ATTEMPT_STATUS = { IN_PROGRESS: 'IN_PROGRESS', SUBMITTED: 'SUBMITTED' } as const;
export type AttemptStatus = (typeof ATTEMPT_STATUS)[keyof typeof ATTEMPT_STATUS];

interface AttemptDocument {
  examId: Types.ObjectId; studentId: Types.ObjectId; startedAt: Date; endsAt: Date; status: AttemptStatus;
  questionOrder: Types.ObjectId[]; optionOrder: Record<string, string[]>; answers: Record<string, string>;
  maxScore: number; score: number | null; correctCount: number | null; graded: boolean;
  submittedAt: Date | null; autoSubmitted: boolean;
}
type Row = AttemptDocument & { _id: Types.ObjectId };

const schema = new mongoose.Schema<AttemptDocument>(
  {
    examId: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', required: true },
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    startedAt: { type: Date, required: true }, endsAt: { type: Date, required: true },
    status: { type: String, enum: Object.values(ATTEMPT_STATUS), default: ATTEMPT_STATUS.IN_PROGRESS },
    questionOrder: { type: [mongoose.Schema.Types.ObjectId], required: true },
    optionOrder: { type: mongoose.Schema.Types.Mixed, default: {} },
    answers: { type: mongoose.Schema.Types.Mixed, default: {} },
    maxScore: { type: Number, required: true },
    score: { type: Number, default: null }, correctCount: { type: Number, default: null }, graded: { type: Boolean, default: false },
    submittedAt: { type: Date, default: null }, autoSubmitted: { type: Boolean, default: false },
  },
  { timestamps: false, versionKey: false, minimize: false },
);
// One attempt per student per exam: the database enforces it.
schema.index({ examId: 1, studentId: 1 }, { unique: true });
schema.index({ status: 1, endsAt: 1 });
schema.index({ studentId: 1, startedAt: -1 });

const AttemptModel: Model<AttemptDocument> =
  (mongoose.models.Attempt as Model<AttemptDocument> | undefined) ?? mongoose.model<AttemptDocument>('Attempt', schema);

export interface AttemptRecord {
  id: string; examId: string; studentId: string; startedAt: Date; endsAt: Date; status: AttemptStatus;
  questionOrder: string[]; optionOrder: Record<string, string[]>; answers: Record<string, string>;
  maxScore: number; score: number | null; correctCount: number | null; graded: boolean; submittedAt: Date | null; autoSubmitted: boolean;
}
export interface GradeResult { score: number; maxScore: number; correctCount: number }

const OBJECT_ID = /^[a-f0-9]{24}$/;
const toRecord = (r: Row): AttemptRecord => ({
  id: r._id.toString(), examId: r.examId.toString(), studentId: r.studentId.toString(), startedAt: r.startedAt, endsAt: r.endsAt,
  status: r.status, questionOrder: r.questionOrder.map(String), optionOrder: r.optionOrder ?? {}, answers: r.answers ?? {},
  maxScore: r.maxScore, score: r.score ?? null, correctCount: r.correctCount ?? null, graded: r.graded,
  submittedAt: r.submittedAt ?? null, autoSubmitted: r.autoSubmitted,
});
const opts = (session?: ClientSession) => (session ? { session } : {});

/** Returns null if this student already has an attempt (a double click, or two devices). */
async function create(data: { examId: string; studentId: string; startedAt: Date; endsAt: Date; questionOrder: string[]; optionOrder: Record<string, string[]>; maxScore: number }): Promise<AttemptRecord | null> {
  try {
    const doc = await AttemptModel.create(data);
    return toRecord(doc.toObject() as Row);
  } catch (err) {
    if (isDuplicateKeyError(err)) return null;
    throw err;
  }
}

async function findById(id: string, session?: ClientSession): Promise<AttemptRecord | null> {
  if (!OBJECT_ID.test(id)) return null;
  const row = await AttemptModel.findById(id, null, opts(session)).lean<Row>();
  return row ? toRecord(row) : null;
}

async function findByExamStudent(examId: string, studentId: string): Promise<AttemptRecord | null> {
  if (!OBJECT_ID.test(examId) || !OBJECT_ID.test(studentId)) return null;
  const row = await AttemptModel.findOne({ examId, studentId }).lean<Row>();
  return row ? toRecord(row) : null;
}

/** Saves answers atomically. Only applies while the attempt is open, up to the cutoff. Returns false otherwise. */
async function saveAnswers(id: string, studentId: string, set: Record<string, string>, unset: string[], cutoff: Date): Promise<boolean> {
  const filter = { _id: id, studentId, status: ATTEMPT_STATUS.IN_PROGRESS, endsAt: { $gt: cutoff } };
  const $set = Object.fromEntries(Object.entries(set).map(([q, v]) => [`answers.${q}`, v]));
  const $unset = Object.fromEntries(unset.map((q) => [`answers.${q}`, '']));
  const update = { ...(Object.keys($set).length > 0 ? { $set } : {}), ...(Object.keys($unset).length > 0 ? { $unset } : {}) };
  if (Object.keys(update).length === 0) return (await AttemptModel.exists(filter)) !== null;
  return (await AttemptModel.updateOne(filter, update)).matchedCount > 0;
}

/** Closes the attempt. Of two simultaneous callers, only one gets it back. */
async function claimSubmission(id: string, at: Date, auto: boolean, session: ClientSession): Promise<AttemptRecord | null> {
  const row = await AttemptModel.findOneAndUpdate(
    { _id: id, status: ATTEMPT_STATUS.IN_PROGRESS },
    { $set: { status: ATTEMPT_STATUS.SUBMITTED, submittedAt: at, autoSubmitted: auto } }, { new: true, session },
  ).lean<Row>();
  return row ? toRecord(row) : null;
}

async function applyGrade(id: string, grade: GradeResult, session: ClientSession): Promise<AttemptRecord | null> {
  const row = await AttemptModel.findOneAndUpdate(
    { _id: id, graded: false }, { $set: { score: grade.score, correctCount: grade.correctCount, maxScore: grade.maxScore, graded: true } },
    { new: true, session },
  ).lean<Row>();
  return row ? toRecord(row) : findById(id, session);
}

async function findOverdueIds(cutoff: Date, limit: number): Promise<string[]> {
  const rows = await AttemptModel.find({ status: ATTEMPT_STATUS.IN_PROGRESS, endsAt: { $lt: cutoff } }, { _id: 1 }).limit(limit).lean<Row[]>();
  return rows.map((r) => r._id.toString());
}

async function findUngradedIds(limit: number): Promise<string[]> {
  const rows = await AttemptModel.find({ status: ATTEMPT_STATUS.SUBMITTED, graded: false }, { _id: 1 }).limit(limit).lean<Row[]>();
  return rows.map((r) => r._id.toString());
}

async function findOverdueForExam(examId: string, cutoff: Date): Promise<string[]> {
  const rows = await AttemptModel.find({ examId, status: ATTEMPT_STATUS.IN_PROGRESS, endsAt: { $lt: cutoff } }, { _id: 1 }).limit(5000).lean<Row[]>();
  return rows.map((r) => r._id.toString());
}

async function listForExam(examId: string, o: { page: number; limit: number }) {
  const [rows, total] = await Promise.all([
    AttemptModel.find({ examId }).sort({ startedAt: 1, _id: 1 }).skip(skipOf(o.page, o.limit)).limit(o.limit).lean<Row[]>(),
    AttemptModel.countDocuments({ examId }),
  ]);
  return { items: rows.map(toRecord), total };
}

/** Every attempt of an exam, for analytics and score feeding. Capped far above any class size. */
async function allForExam(examId: string): Promise<AttemptRecord[]> {
  const rows = await AttemptModel.find({ examId }).limit(5000).lean<Row[]>();
  return rows.map(toRecord);
}

async function forStudentExams(studentId: string, examIds: string[]): Promise<Map<string, AttemptRecord>> {
  const ids = examIds.filter((id) => OBJECT_ID.test(id));
  if (ids.length === 0 || !OBJECT_ID.test(studentId)) return new Map();
  const rows = await AttemptModel.find({ studentId, examId: { $in: ids } }).lean<Row[]>();
  return new Map(rows.map((r) => [r.examId.toString(), toRecord(r)]));
}

const countForExam = (examId: string): Promise<number> => AttemptModel.countDocuments({ examId });

export const attemptRepository = {
  create, findById, findByExamStudent, saveAnswers, claimSubmission, applyGrade,
  findOverdueIds, findUngradedIds, findOverdueForExam, listForExam, allForExam, forStudentExams, countForExam,
};