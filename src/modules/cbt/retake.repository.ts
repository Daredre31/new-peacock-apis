import mongoose, { type ClientSession, type Model, type Types } from 'mongoose';
import { isDuplicateKeyError } from '../../common/utils/mongoErrors';
import { skipOf } from '../../common/utils/pagination';

export const RETAKE_STATUS = { PENDING: 'PENDING', APPROVED: 'APPROVED', REJECTED: 'REJECTED', USED: 'USED', REVOKED: 'REVOKED' } as const;
export type RetakeStatus = (typeof RETAKE_STATUS)[keyof typeof RETAKE_STATUS];
export const RETAKE_STATUSES = Object.values(RETAKE_STATUS) as [RetakeStatus, ...RetakeStatus[]];

/**
 * A teacher's request to let one student sit an exam again, and the admin's decision on it.
 * `open` is true while the request is PENDING or APPROVED. A partial unique index on it means a student can
 * never have two live requests for the same exam, without needing a database feature newer than equality.
 */
interface RetakeDocument {
  examId: Types.ObjectId; studentId: Types.ObjectId; requestedBy: Types.ObjectId; reason: string;
  status: RetakeStatus; open: boolean;
  /** The sitting this retake follows. */
  attemptId: Types.ObjectId; attemptNumber: number;
  decidedBy: Types.ObjectId | null; decidedAt: Date | null; decisionNote: string | null;
  expiresAt: Date | null; usedAt: Date | null; newAttemptId: Types.ObjectId | null;
  createdAt: Date; updatedAt: Date;
}
type Row = RetakeDocument & { _id: Types.ObjectId };

const oid = { type: mongoose.Schema.Types.ObjectId };
const schema = new mongoose.Schema<RetakeDocument>(
  {
    examId: { ...oid, required: true }, studentId: { ...oid, required: true }, requestedBy: { ...oid, required: true },
    reason: { type: String, required: true, maxlength: 500 },
    status: { type: String, enum: RETAKE_STATUSES, default: RETAKE_STATUS.PENDING },
    open: { type: Boolean, default: true },
    attemptId: { ...oid, required: true }, attemptNumber: { type: Number, required: true },
    decidedBy: { ...oid, default: null }, decidedAt: { type: Date, default: null }, decisionNote: { type: String, default: null, maxlength: 500 },
    expiresAt: { type: Date, default: null }, usedAt: { type: Date, default: null }, newAttemptId: { ...oid, default: null },
  },
  { collection: 'exam_retakes', timestamps: true, versionKey: false },
);
schema.index({ examId: 1, studentId: 1 }, { unique: true, partialFilterExpression: { open: true } });
schema.index({ examId: 1, createdAt: -1 });
schema.index({ status: 1, createdAt: -1 });
schema.index({ requestedBy: 1, createdAt: -1 });

const RetakeModel: Model<RetakeDocument> =
  (mongoose.models.ExamRetake as Model<RetakeDocument> | undefined) ?? mongoose.model<RetakeDocument>('ExamRetake', schema);

export interface RetakeRecord {
  id: string; examId: string; studentId: string; requestedBy: string; reason: string; status: RetakeStatus;
  attemptId: string; attemptNumber: number; decidedBy: string | null; decidedAt: Date | null; decisionNote: string | null;
  expiresAt: Date | null; usedAt: Date | null; newAttemptId: string | null; createdAt: Date;
}
const OBJECT_ID = /^[a-f0-9]{24}$/;
const toRecord = (r: Row): RetakeRecord => ({
  id: r._id.toString(), examId: r.examId.toString(), studentId: r.studentId.toString(), requestedBy: r.requestedBy.toString(),
  reason: r.reason, status: r.status, attemptId: r.attemptId.toString(), attemptNumber: r.attemptNumber,
  decidedBy: r.decidedBy ? r.decidedBy.toString() : null, decidedAt: r.decidedAt ?? null, decisionNote: r.decisionNote ?? null,
  expiresAt: r.expiresAt ?? null, usedAt: r.usedAt ?? null, newAttemptId: r.newAttemptId ? r.newAttemptId.toString() : null, createdAt: r.createdAt,
});

export interface NewRetake { examId: string; studentId: string; requestedBy: string; reason: string; attemptId: string; attemptNumber: number }

/** Saves each request on its own. A student who already has a live request for this exam is returned in `duplicates`. */
async function createMany(rows: NewRetake[]): Promise<{ created: RetakeRecord[]; duplicates: string[] }> {
  const created: RetakeRecord[] = [];
  const duplicates: string[] = [];
  for (const data of rows) {
    try {
      const doc = await RetakeModel.create(data);
      created.push(toRecord(doc.toObject() as Row));
    } catch (err) {
      if (isDuplicateKeyError(err)) duplicates.push(data.studentId);
      else throw err;
    }
  }
  return { created, duplicates };
}

async function findById(id: string): Promise<RetakeRecord | null> {
  if (!OBJECT_ID.test(id)) return null;
  const row = await RetakeModel.findById(id).lean<Row>();
  return row ? toRecord(row) : null;
}

async function list(filter: { examId?: string | undefined; requestedBy?: string | undefined; status?: RetakeStatus | undefined }, o: { page: number; limit: number }) {
  const query: Record<string, unknown> = {};
  for (const key of ['examId', 'requestedBy', 'status'] as const) if (filter[key] !== undefined) query[key] = filter[key];
  const [rows, total] = await Promise.all([
    RetakeModel.find(query).sort({ createdAt: -1, _id: -1 }).skip(skipOf(o.page, o.limit)).limit(o.limit).lean<Row[]>(),
    RetakeModel.countDocuments(query),
  ]);
  return { items: rows.map(toRecord), total };
}

async function forStudentExam(examId: string, studentId: string): Promise<RetakeRecord[]> {
  if (!OBJECT_ID.test(examId) || !OBJECT_ID.test(studentId)) return [];
  const rows = await RetakeModel.find({ examId, studentId }).sort({ createdAt: 1 }).lean<Row[]>();
  return rows.map(toRecord);
}

/** An admin approves a request that is still waiting. Only one of two simultaneous decisions wins. */
async function approve(id: string, by: string, at: Date, expiresAt: Date | null): Promise<RetakeRecord | null> {
  const row = await RetakeModel.findOneAndUpdate(
    { _id: id, status: RETAKE_STATUS.PENDING },
    { $set: { status: RETAKE_STATUS.APPROVED, decidedBy: by, decidedAt: at, expiresAt } }, { new: true },
  ).lean<Row>();
  return row ? toRecord(row) : null;
}

async function reject(id: string, by: string, at: Date, note: string): Promise<RetakeRecord | null> {
  const row = await RetakeModel.findOneAndUpdate(
    { _id: id, status: RETAKE_STATUS.PENDING },
    { $set: { status: RETAKE_STATUS.REJECTED, open: false, decidedBy: by, decidedAt: at, decisionNote: note } }, { new: true },
  ).lean<Row>();
  return row ? toRecord(row) : null;
}

/** Withdraws a request that is waiting, or cancels an approval nobody has used yet. */
async function revoke(id: string, from: RetakeStatus[], by: string, at: Date): Promise<RetakeRecord | null> {
  const row = await RetakeModel.findOneAndUpdate(
    { _id: id, status: { $in: from } },
    { $set: { status: RETAKE_STATUS.REVOKED, open: false, decidedBy: by, decidedAt: at } }, { new: true },
  ).lean<Row>();
  return row ? toRecord(row) : null;
}

/** The approval a student can use now: approved, not used, not expired. */
async function usableFor(examId: string, studentId: string, now: Date): Promise<RetakeRecord | null> {
  if (!OBJECT_ID.test(examId) || !OBJECT_ID.test(studentId)) return null;
  const row = await RetakeModel.findOne({
    examId, studentId, status: RETAKE_STATUS.APPROVED, $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  }).lean<Row>();
  return row ? toRecord(row) : null;
}

async function usableForStudentExams(studentId: string, examIds: string[], now: Date): Promise<Map<string, RetakeRecord>> {
  const ids = examIds.filter((id) => OBJECT_ID.test(id));
  if (ids.length === 0 || !OBJECT_ID.test(studentId)) return new Map();
  const rows = await RetakeModel.find({
    studentId, examId: { $in: ids }, status: RETAKE_STATUS.APPROVED, $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  }).lean<Row[]>();
  return new Map(rows.map((r) => [r.examId.toString(), toRecord(r)]));
}

/** Uses up an approval, once. Null if it was already used, cancelled or has expired. Runs inside the retake's transaction. */
async function consume(id: string, now: Date, newAttemptId: string, session: ClientSession): Promise<boolean> {
  const row = await RetakeModel.findOneAndUpdate(
    { _id: id, status: RETAKE_STATUS.APPROVED, $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] },
    { $set: { status: RETAKE_STATUS.USED, open: false, usedAt: now, newAttemptId } }, { new: true, session },
  ).lean<Row>();
  return row !== null;
}

/** Is any request for this exam still waiting or approved but unused? */
async function hasOpen(examId: string): Promise<boolean> {
  if (!OBJECT_ID.test(examId)) return false;
  return (await RetakeModel.exists({ examId, open: true })) !== null;
}

export const retakeRepository = { createMany, findById, list, forStudentExam, approve, reject, revoke, usableFor, usableForStudentExams, consume, hasOpen };
