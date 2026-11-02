import mongoose, { type Model, type Types } from 'mongoose';
import type { Components } from './results.engine';

export const SCORE_STATUS = { DRAFT: 'DRAFT', SUBMITTED: 'SUBMITTED', MODERATED: 'MODERATED', PUBLISHED: 'PUBLISHED' } as const;
export type ScoreStatus = (typeof SCORE_STATUS)[keyof typeof SCORE_STATUS];

interface ScoreDocument {
  studentId: Types.ObjectId; // the student's user id
  classArmId: Types.ObjectId;
  subjectId: Types.ObjectId;
  termId: Types.ObjectId;
  components: Components;
  total: number;
  grade: string | null; // stamped at publish
  remark: string | null;
  status: ScoreStatus;
  locked: boolean;
  rev: number; // bumped on every change, so two simultaneous edits cannot both win
  editedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}
type Row = ScoreDocument & { _id: Types.ObjectId };

const oid = (ref: string) => ({ type: mongoose.Schema.Types.ObjectId, ref, required: true });
const schema = new mongoose.Schema<ScoreDocument>(
  {
    studentId: oid('User'), classArmId: oid('ClassArm'), subjectId: oid('Subject'), termId: oid('Term'),
    components: { type: mongoose.Schema.Types.Mixed, default: {} },
    total: { type: Number, default: 0 },
    grade: { type: String, default: null },
    remark: { type: String, default: null },
    status: { type: String, enum: Object.values(SCORE_STATUS), default: SCORE_STATUS.DRAFT },
    locked: { type: Boolean, default: false },
    rev: { type: Number, default: 0 },
    editedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: true, versionKey: false, minimize: false },
);
schema.index({ studentId: 1, subjectId: 1, termId: 1 }, { unique: true });
schema.index({ classArmId: 1, termId: 1, subjectId: 1 });
schema.index({ studentId: 1, termId: 1 });

const ScoreModel: Model<ScoreDocument> =
  (mongoose.models.Score as Model<ScoreDocument> | undefined) ?? mongoose.model<ScoreDocument>('Score', schema);

export interface ScoreRecord {
  id: string; studentId: string; classArmId: string; subjectId: string; termId: string;
  components: Components; total: number; grade: string | null; remark: string | null;
  status: ScoreStatus; locked: boolean; rev: number;
}
export interface ScoreWrite {
  studentId: string; classArmId: string; subjectId: string; termId: string;
  components: Components; total: number;
  /** What the writer saw. The write only applies if nobody changed it since. */
  expect: { rev: number; status: ScoreStatus; locked: boolean };
}

const OBJECT_ID = /^[a-f0-9]{24}$/;
const toRecord = (r: Row): ScoreRecord => ({
  id: r._id.toString(), studentId: r.studentId.toString(), classArmId: r.classArmId.toString(),
  subjectId: r.subjectId.toString(), termId: r.termId.toString(), components: r.components ?? {},
  total: r.total, grade: r.grade ?? null, remark: r.remark ?? null, status: r.status, locked: r.locked, rev: r.rev,
});

const forGrid = async (classArmId: string, subjectId: string, termId: string): Promise<ScoreRecord[]> =>
  (await ScoreModel.find({ classArmId, subjectId, termId }).lean<Row[]>()).map(toRecord);

const forArmTerm = async (classArmId: string, termId: string): Promise<ScoreRecord[]> =>
  (await ScoreModel.find({ classArmId, termId }).lean<Row[]>()).map(toRecord);

async function forStudent(studentId: string, termId?: string): Promise<ScoreRecord[]> {
  if (!OBJECT_ID.test(studentId)) return [];
  const rows = await ScoreModel.find({ studentId, ...(termId ? { termId } : {}) }).lean<Row[]>();
  return rows.map(toRecord);
}

const anyExists = async (): Promise<boolean> => (await ScoreModel.exists({})) !== null;
const lockedExists = async (classArmId: string, termId: string): Promise<boolean> =>
  (await ScoreModel.exists({ classArmId, termId, locked: true })) !== null;

/** Writes with optimistic checks. A score changed by someone else in the meantime raises a duplicate-key error. */
async function saveMany(writes: ScoreWrite[], editedBy: string): Promise<void> {
  if (writes.length === 0) return;
  await ScoreModel.bulkWrite(
    writes.map((w) => ({
      updateOne: {
        filter: { studentId: w.studentId, subjectId: w.subjectId, termId: w.termId, rev: w.expect.rev, status: w.expect.status, locked: w.expect.locked },
        update: { $set: { classArmId: w.classArmId, components: w.components, total: w.total, editedBy }, $inc: { rev: 1 } },
        upsert: true,
      },
    })),
    { ordered: false },
  );
}

async function transition(filter: { classArmId: string; termId: string; subjectId?: string }, from: ScoreStatus, to: ScoreStatus): Promise<number> {
  const result = await ScoreModel.updateMany({ ...filter, status: from }, { $set: { status: to }, $inc: { rev: 1 } });
  return result.modifiedCount;
}

/** Sets status, lock and the stamped grade on specific scores. Returns how many applied. */
async function stampMany(items: { id: string; rev: number; grade: string; remark: string }[], from: ScoreStatus, to: ScoreStatus, locked: boolean): Promise<number> {
  if (items.length === 0) return 0;
  const result = await ScoreModel.bulkWrite(
    items.map((i) => ({
      updateOne: {
        filter: { _id: i.id, rev: i.rev, status: from },
        update: { $set: { status: to, locked, grade: i.grade, remark: i.remark }, $inc: { rev: 1 } },
      },
    })),
    { ordered: false },
  );
  return result.modifiedCount;
}

async function setLocked(classArmId: string, termId: string, locked: boolean): Promise<number> {
  const result = await ScoreModel.updateMany(
    { classArmId, termId, status: SCORE_STATUS.PUBLISHED, locked: !locked },
    { $set: { locked }, $inc: { rev: 1 } },
  );
  return result.modifiedCount;
}

export const scoreRepository = { forGrid, forArmTerm, forStudent, anyExists, lockedExists, saveMany, transition, stampMany, setLocked };