import mongoose, { type Model, type Types } from 'mongoose';
import { skipOf } from '../../common/utils/pagination';

export interface Discrepancy { kind: string; reference: string | null; detail: string }
export type RunKind = 'SCHEDULED' | 'MANUAL';
export type RunStatus = 'RUNNING' | 'COMPLETED' | 'FAILED';

interface RunDocument {
  kind: RunKind; status: RunStatus; windowFrom: Date; windowTo: Date; triggeredBy: Types.ObjectId | null;
  checked: number; fixed: number; complete: boolean; discrepancies: Discrepancy[]; error: string | null; startedAt: Date; finishedAt: Date | null;
}
type Row = RunDocument & { _id: Types.ObjectId };

const discrepancySchema = new mongoose.Schema(
  {
    kind: { type: String, required: true, maxlength: 60 },
    reference: { type: String, default: null },
    detail: { type: String, required: true, maxlength: 500 },
  },
  { _id: false },
);

const schema = new mongoose.Schema<RunDocument>(
  {
    kind: { type: String, enum: ['SCHEDULED', 'MANUAL'], required: true },
    status: { type: String, enum: ['RUNNING', 'COMPLETED', 'FAILED'], required: true },
    windowFrom: { type: Date, required: true }, windowTo: { type: Date, required: true },
    triggeredBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    checked: { type: Number, default: 0 }, fixed: { type: Number, default: 0 }, complete: { type: Boolean, default: false },
    discrepancies: { type: [discrepancySchema], default: [] },
    error: { type: String, default: null }, startedAt: { type: Date, required: true }, finishedAt: { type: Date, default: null },
  },
  { versionKey: false, minimize: false },
);
schema.index({ startedAt: -1 });
schema.index({ startedAt: 1 }, { expireAfterSeconds: 365 * 86_400 });

const RunModel: Model<RunDocument> =
  (mongoose.models.ReconciliationRun as Model<RunDocument> | undefined) ?? mongoose.model<RunDocument>('ReconciliationRun', schema);

export interface RunRecord {
  id: string; kind: RunKind; status: RunStatus; windowFrom: Date; windowTo: Date; checked: number; fixed: number; complete: boolean;
  discrepancies: Discrepancy[]; error: string | null; startedAt: Date; finishedAt: Date | null;
}
const toRecord = (r: Row): RunRecord => ({
  id: r._id.toString(), kind: r.kind, status: r.status, windowFrom: r.windowFrom, windowTo: r.windowTo, checked: r.checked, fixed: r.fixed,
  complete: r.complete, discrepancies: (r.discrepancies ?? []).slice(0, 200), error: r.error ?? null, startedAt: r.startedAt, finishedAt: r.finishedAt ?? null,
});

async function start(data: { kind: RunKind; windowFrom: Date; windowTo: Date; triggeredBy: string | null }): Promise<string> {
  const doc = await RunModel.create({ ...data, status: 'RUNNING', startedAt: new Date() });
  return doc._id.toString();
}

async function finish(id: string, result: { checked: number; fixed: number; complete: boolean; discrepancies: Discrepancy[] }): Promise<RunRecord | null> {
  const row = await RunModel.findByIdAndUpdate(id, { $set: { ...result, status: 'COMPLETED', finishedAt: new Date() } }, { new: true }).lean<Row>();
  return row ? toRecord(row) : null;
}

async function fail(id: string, error: string): Promise<void> {
  await RunModel.updateOne({ _id: id }, { $set: { status: 'FAILED', error: error.slice(0, 300), finishedAt: new Date() } });
}

async function list(o: { page: number; limit: number }) {
  const [rows, total] = await Promise.all([
    RunModel.find({}).sort({ startedAt: -1 }).skip(skipOf(o.page, o.limit)).limit(o.limit).lean<Row[]>(),
    RunModel.countDocuments({}),
  ]);
  return { items: rows.map(toRecord), total };
}

export const reconciliationRepository = { start, finish, fail, list };