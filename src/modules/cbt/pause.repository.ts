import mongoose, { type ClientSession, type Model, type Types } from 'mongoose';

/** One row per pause: who paused the exam, when, why, and who resumed it. */
interface PauseDocument {
  examId: Types.ObjectId; pausedAt: Date; pausedBy: Types.ObjectId; reason: string | null;
  resumedAt: Date | null; resumedBy: Types.ObjectId | null;
  /** How far every running attempt's end time (and the exam window) was moved when the pause ended. */
  extendedMs: number | null;
}
type Row = PauseDocument & { _id: Types.ObjectId };

const schema = new mongoose.Schema<PauseDocument>(
  {
    examId: { type: mongoose.Schema.Types.ObjectId, required: true },
    pausedAt: { type: Date, required: true },
    pausedBy: { type: mongoose.Schema.Types.ObjectId, required: true },
    reason: { type: String, default: null, maxlength: 500 },
    resumedAt: { type: Date, default: null },
    resumedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    extendedMs: { type: Number, default: null },
  },
  { collection: 'exam_pauses', timestamps: false, versionKey: false },
);
schema.index({ examId: 1, pausedAt: -1 });

const PauseModel: Model<PauseDocument> =
  (mongoose.models.ExamPause as Model<PauseDocument> | undefined) ?? mongoose.model<PauseDocument>('ExamPause', schema);

export interface PauseRecord {
  id: string; examId: string; pausedAt: Date; pausedBy: string; reason: string | null;
  resumedAt: Date | null; resumedBy: string | null; extendedMs: number | null;
}
const toRecord = (r: Row): PauseRecord => ({
  id: r._id.toString(), examId: r.examId.toString(), pausedAt: r.pausedAt, pausedBy: r.pausedBy.toString(), reason: r.reason ?? null,
  resumedAt: r.resumedAt ?? null, resumedBy: r.resumedBy ? r.resumedBy.toString() : null, extendedMs: r.extendedMs ?? null,
});

async function open(examId: string, pausedAt: Date, pausedBy: string, reason: string | null, session: ClientSession): Promise<void> {
  await PauseModel.create([{ examId, pausedAt, pausedBy, reason }], { session });
}

/** Closes the pause that is still open for this exam. */
async function close(examId: string, resumedAt: Date, resumedBy: string, extendedMs: number, session: ClientSession): Promise<void> {
  await PauseModel.updateOne({ examId, resumedAt: null }, { $set: { resumedAt, resumedBy, extendedMs } }, { session });
}

async function list(examId: string): Promise<PauseRecord[]> {
  if (!/^[a-f0-9]{24}$/.test(examId)) return [];
  const rows = await PauseModel.find({ examId }).sort({ pausedAt: -1 }).limit(200).lean<Row[]>();
  return rows.map(toRecord);
}

export const pauseRepository = { open, close, list };
