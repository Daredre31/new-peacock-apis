import mongoose, { type Model, type Types } from 'mongoose';
import { skipOf } from '../../common/utils/pagination';
import { EXAM_STATUS, EXAM_TYPES, type ExamSettings, type ExamStatus, type ExamType } from './cbt.types';

interface ExamDocument {
  title: string; subjectId: Types.ObjectId; classArmIds: Types.ObjectId[]; teacherId: Types.ObjectId;
  sessionId: Types.ObjectId; termId: Types.ObjectId; type: ExamType; durationMin: number;
  windowStart: Date; windowEnd: Date; instructions: string; settings: ExamSettings;
  status: ExamStatus; rejectionReason: string | null; decidedBy: Types.ObjectId | null; decidedAt: Date | null;
  resultsReleased: boolean; resultsReleasedAt: Date | null; questionCount: number; maxScore: number;
  createdAt: Date; updatedAt: Date;
}
type Row = ExamDocument & { _id: Types.ObjectId };

const oid = (ref: string) => ({ type: mongoose.Schema.Types.ObjectId, ref, required: true });
const settingsSchema = new mongoose.Schema(
  {
    shuffleQuestions: Boolean, shuffleOptions: Boolean, showAnswers: Boolean,
    resultRelease: { type: String, enum: ['IMMEDIATE', 'MANUAL'] },
    passMarkPercent: Number, scoreComponent: { type: String, default: null },
  },
  { _id: false },
);

const schema = new mongoose.Schema<ExamDocument>(
  {
    title: { type: String, required: true, maxlength: 150 },
    subjectId: oid('Subject'),
    classArmIds: { type: [mongoose.Schema.Types.ObjectId], required: true },
    teacherId: oid('User'), sessionId: oid('Session'), termId: oid('Term'),
    type: { type: String, enum: EXAM_TYPES, required: true },
    durationMin: { type: Number, required: true },
    windowStart: { type: Date, required: true }, windowEnd: { type: Date, required: true },
    instructions: { type: String, default: '', maxlength: 2000 },
    settings: { type: settingsSchema, required: true },
    status: { type: String, enum: Object.values(EXAM_STATUS), default: EXAM_STATUS.DRAFT },
    rejectionReason: { type: String, default: null },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, default: null }, decidedAt: { type: Date, default: null },
    resultsReleased: { type: Boolean, default: false }, resultsReleasedAt: { type: Date, default: null },
    questionCount: { type: Number, default: 0 }, maxScore: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false },
);
schema.index({ windowStart: 1, status: 1 });
schema.index({ teacherId: 1, windowStart: -1 });
schema.index({ classArmIds: 1, status: 1, windowEnd: -1 });

const ExamModel: Model<ExamDocument> =
  (mongoose.models.Exam as Model<ExamDocument> | undefined) ?? mongoose.model<ExamDocument>('Exam', schema);

export interface ExamRecord {
  id: string; title: string; subjectId: string; classArmIds: string[]; teacherId: string; sessionId: string; termId: string;
  type: ExamType; durationMin: number; windowStart: Date; windowEnd: Date; instructions: string; settings: ExamSettings;
  status: ExamStatus; rejectionReason: string | null; resultsReleased: boolean; resultsReleasedAt: Date | null;
  questionCount: number; maxScore: number; createdAt: Date;
}
export type ExamFields = Pick<ExamRecord, 'title' | 'subjectId' | 'classArmIds' | 'teacherId' | 'sessionId' | 'termId' | 'type' | 'durationMin' | 'windowStart' | 'windowEnd' | 'instructions' | 'settings'>;

const OBJECT_ID = /^[a-f0-9]{24}$/;
const EDITABLE: ExamStatus[] = [EXAM_STATUS.DRAFT, EXAM_STATUS.REJECTED];
const toRecord = (r: Row): ExamRecord => ({
  id: r._id.toString(), title: r.title, subjectId: r.subjectId.toString(), classArmIds: r.classArmIds.map(String),
  teacherId: r.teacherId.toString(), sessionId: r.sessionId.toString(), termId: r.termId.toString(), type: r.type,
  durationMin: r.durationMin, windowStart: r.windowStart, windowEnd: r.windowEnd, instructions: r.instructions ?? '',
  settings: { shuffleQuestions: r.settings.shuffleQuestions, shuffleOptions: r.settings.shuffleOptions, resultRelease: r.settings.resultRelease, showAnswers: r.settings.showAnswers, passMarkPercent: r.settings.passMarkPercent, scoreComponent: r.settings.scoreComponent ?? null },
  status: r.status, rejectionReason: r.rejectionReason ?? null, resultsReleased: r.resultsReleased,
  resultsReleasedAt: r.resultsReleasedAt ?? null, questionCount: r.questionCount, maxScore: r.maxScore, createdAt: r.createdAt,
});

async function create(data: ExamFields): Promise<ExamRecord> {
  const doc = await ExamModel.create(data);
  return toRecord(doc.toObject() as Row);
}

async function findById(id: string): Promise<ExamRecord | null> {
  if (!OBJECT_ID.test(id)) return null;
  const row = await ExamModel.findById(id).lean<Row>();
  return row ? toRecord(row) : null;
}

/** Only the owner can change an exam, and only while it is a draft or was rejected. */
async function updateEditable(id: string, ownerId: string, patch: Partial<ExamFields>): Promise<ExamRecord | null> {
  const row = await ExamModel.findOneAndUpdate(
    { _id: id, teacherId: ownerId, status: { $in: EDITABLE } }, { $set: patch }, { new: true },
  ).lean<Row>();
  return row ? toRecord(row) : null;
}

async function remove(id: string): Promise<boolean> {
  return (await ExamModel.deleteOne({ _id: id })).deletedCount > 0;
}

async function list(
  filter: { teacherId?: string | undefined; status?: ExamStatus | undefined; type?: ExamType | undefined; subjectId?: string | undefined; classArmId?: string | undefined; from?: Date | undefined; to?: Date | undefined },
  o: { page: number; limit: number },
) {
  const query: Record<string, unknown> = {};
  for (const key of ['teacherId', 'status', 'type', 'subjectId'] as const) if (filter[key] !== undefined) query[key] = filter[key];
  if (filter.classArmId) query.classArmIds = filter.classArmId;
  if (filter.from || filter.to) query.windowStart = { ...(filter.from ? { $gte: filter.from } : {}), ...(filter.to ? { $lte: filter.to } : {}) };

  const [rows, total] = await Promise.all([
    ExamModel.find(query).sort({ windowStart: -1, _id: -1 }).skip(skipOf(o.page, o.limit)).limit(o.limit).lean<Row[]>(),
    ExamModel.countDocuments(query),
  ]);
  return { items: rows.map(toRecord), total };
}

/** Atomic status change: it only applies if the exam is still in one of the expected statuses. */
async function transition(
  id: string, from: ExamStatus[], to: ExamStatus,
  extra: { rejectionReason?: string | null; decidedBy?: string; decidedAt?: Date } = {},
): Promise<ExamRecord | null> {
  const row = await ExamModel.findOneAndUpdate({ _id: id, status: { $in: from } }, { $set: { status: to, ...extra } }, { new: true }).lean<Row>();
  return row ? toRecord(row) : null;
}

/** Part of the question-replace transaction. Matches nothing, and so fails it, if the exam is no longer editable. */
async function setQuestionStats(id: string, count: number, maxScore: number, session: mongoose.ClientSession): Promise<boolean> {
  const result = await ExamModel.updateOne({ _id: id, status: { $in: EDITABLE } }, { $set: { questionCount: count, maxScore } }, { session });
  return result.matchedCount > 0;
}

async function markReleased(id: string, now: Date): Promise<ExamRecord | null> {
  const row = await ExamModel.findOneAndUpdate(
    { _id: id, status: EXAM_STATUS.PUBLISHED, resultsReleased: false, windowEnd: { $lte: now } },
    { $set: { resultsReleased: true, resultsReleasedAt: now } }, { new: true },
  ).lean<Row>();
  return row ? toRecord(row) : null;
}

async function listForArm(armId: string, sessionId: string, since: Date): Promise<ExamRecord[]> {
  if (!OBJECT_ID.test(armId) || !OBJECT_ID.test(sessionId)) return [];
  const rows = await ExamModel.find({ classArmIds: armId, sessionId, status: EXAM_STATUS.PUBLISHED, windowEnd: { $gte: since } })
    .sort({ windowStart: -1 }).limit(100).lean<Row[]>();
  return rows.map(toRecord);
}

async function upcomingForTeacher(teacherId: string, now: Date, limit: number): Promise<ExamRecord[]> {
  if (!OBJECT_ID.test(teacherId)) return [];
  const rows = await ExamModel.find({ teacherId, status: EXAM_STATUS.PUBLISHED, windowEnd: { $gte: now } })
    .sort({ windowStart: 1 }).limit(limit).lean<Row[]>();
  return rows.map(toRecord);
}

export const examRepository = { create, findById, updateEditable, remove, list, transition, setQuestionStats, markReleased, listForArm , upcomingForTeacher};