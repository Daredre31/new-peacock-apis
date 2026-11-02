import mongoose, { type Model, type Types } from 'mongoose';

export const CONDUCT = ['EXCELLENT', 'VERY_GOOD', 'GOOD', 'FAIR', 'POOR'] as const;
export type Conduct = (typeof CONDUCT)[number];

export interface AttendanceSummary { present: number; absent: number; late: number; excused: number; days: number; rate: number | null }

interface ReportCardDocument {
  studentId: Types.ObjectId; classArmId: Types.ObjectId; termId: Types.ObjectId;
  conduct: Conduct | null; remark: string | null; attendance: AttendanceSummary | null;
  updatedBy: Types.ObjectId | null; createdAt: Date; updatedAt: Date;
}
type Row = ReportCardDocument & { _id: Types.ObjectId };

const schema = new mongoose.Schema<ReportCardDocument>(
  {
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    classArmId: { type: mongoose.Schema.Types.ObjectId, ref: 'ClassArm', required: true },
    termId: { type: mongoose.Schema.Types.ObjectId, ref: 'Term', required: true },
    conduct: { type: String, enum: CONDUCT, default: null },
    remark: { type: String, default: null, maxlength: 300 },
    attendance: { type: mongoose.Schema.Types.Mixed, default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: true, versionKey: false },
);
schema.index({ studentId: 1, termId: 1 }, { unique: true });
schema.index({ classArmId: 1, termId: 1 });

const ReportCardModel: Model<ReportCardDocument> =
  (mongoose.models.ReportCard as Model<ReportCardDocument> | undefined) ?? mongoose.model<ReportCardDocument>('ReportCard', schema);

export interface ReportCardRecord { studentId: string; conduct: Conduct | null; remark: string | null; attendance: AttendanceSummary | null }

const toRecord = (r: Row): ReportCardRecord => ({ studentId: r.studentId.toString(), conduct: r.conduct ?? null, remark: r.remark ?? null, attendance: r.attendance ?? null });

async function forArmTerm(classArmId: string, termId: string): Promise<Map<string, ReportCardRecord>> {
  const rows = await ReportCardModel.find({ classArmId, termId }).lean<Row[]>();
  return new Map(rows.map((r) => [r.studentId.toString(), toRecord(r)]));
}

async function forStudentTerm(studentId: string, termId: string): Promise<ReportCardRecord | null> {
  const row = await ReportCardModel.findOne({ studentId, termId }).lean<Row>();
  return row ? toRecord(row) : null;
}

async function upsertMany(
  entries: { studentId: string; conduct?: Conduct | undefined; remark?: string | null | undefined }[],
  classArmId: string, termId: string, updatedBy: string,
): Promise<void> {
  if (entries.length === 0) return;
  await ReportCardModel.bulkWrite(
    entries.map((e) => ({
      updateOne: {
        filter: { studentId: e.studentId, termId },
        update: { $set: { classArmId, updatedBy, ...(e.conduct !== undefined ? { conduct: e.conduct } : {}), ...(e.remark !== undefined ? { remark: e.remark } : {}) } },
        upsert: true,
      },
    })),
    { ordered: false },
  );
}

async function snapshotAttendance(classArmId: string, termId: string, summaries: Map<string, AttendanceSummary>): Promise<void> {
  if (summaries.size === 0) return;
  await ReportCardModel.bulkWrite(
    [...summaries].map(([studentId, attendance]) => ({
      updateOne: { filter: { studentId, termId }, update: { $set: { classArmId, attendance } }, upsert: true },
    })),
    { ordered: false },
  );
}

export const reportCardRepository = { forArmTerm, forStudentTerm, upsertMany, snapshotAttendance };