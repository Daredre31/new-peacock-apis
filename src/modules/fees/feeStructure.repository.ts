import mongoose, { type Model, type Types } from 'mongoose';
import { skipOf } from '../../common/utils/pagination';

export const FEE_STRUCTURE_STATUS = { DRAFT: 'DRAFT', APPROVED: 'APPROVED' } as const;
export type FeeStructureStatus = (typeof FEE_STRUCTURE_STATUS)[keyof typeof FEE_STRUCTURE_STATUS];
export interface FeeItem { name: string; amountKobo: number }

interface FeeStructureDocument {
  name: string; classId: Types.ObjectId; termId: Types.ObjectId; sessionId: Types.ObjectId;
  items: FeeItem[]; totalKobo: number; status: FeeStructureStatus;
  createdBy: Types.ObjectId; approvedBy: Types.ObjectId | null; approvedAt: Date | null; createdAt: Date; updatedAt: Date;
}
type Row = FeeStructureDocument & { _id: Types.ObjectId };

const itemSchema = new mongoose.Schema(
  { name: { type: String, required: true, maxlength: 60 }, amountKobo: { type: Number, required: true, min: 1 } },
  { _id: false },
);
const schema = new mongoose.Schema<FeeStructureDocument>(
  {
    name: { type: String, required: true, maxlength: 100 },
    classId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true },
    termId: { type: mongoose.Schema.Types.ObjectId, ref: 'Term', required: true },
    sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', required: true },
    items: { type: [itemSchema], required: true },
    totalKobo: { type: Number, required: true, min: 1 },
    status: { type: String, enum: Object.values(FEE_STRUCTURE_STATUS), default: FEE_STRUCTURE_STATUS.DRAFT },
    createdBy: { type: mongoose.Schema.Types.ObjectId, required: true },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    approvedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);
// One price list per class per term, so an invoice never has two possible fee structures.
schema.index({ termId: 1, classId: 1 }, { unique: true });
schema.index({ status: 1, createdAt: -1 });

const FeeStructureModel: Model<FeeStructureDocument> =
  (mongoose.models.FeeStructure as Model<FeeStructureDocument> | undefined) ??
  mongoose.model<FeeStructureDocument>('FeeStructure', schema);

export interface FeeStructureRecord {
  id: string; name: string; classId: string; termId: string; sessionId: string; items: FeeItem[]; totalKobo: number;
  status: FeeStructureStatus; createdBy: string; approvedAt: Date | null; createdAt: Date;
}

const OBJECT_ID = /^[a-f0-9]{24}$/;
const toRecord = (r: Row): FeeStructureRecord => ({
  id: r._id.toString(), name: r.name, classId: r.classId.toString(), termId: r.termId.toString(), sessionId: r.sessionId.toString(),
  items: r.items.map((i) => ({ name: i.name, amountKobo: i.amountKobo })), totalKobo: r.totalKobo, status: r.status,
  createdBy: r.createdBy.toString(), approvedAt: r.approvedAt ?? null, createdAt: r.createdAt,
});

async function create(data: { name: string; classId: string; termId: string; sessionId: string; items: FeeItem[]; totalKobo: number; createdBy: string }): Promise<FeeStructureRecord> {
  const doc = await FeeStructureModel.create(data);
  return toRecord(doc.toObject() as Row);
}

async function findById(id: string): Promise<FeeStructureRecord | null> {
  if (!OBJECT_ID.test(id)) return null;
  const row = await FeeStructureModel.findById(id).lean<Row>();
  return row ? toRecord(row) : null;
}

async function findApproved(termId: string, classId: string): Promise<FeeStructureRecord | null> {
  if (!OBJECT_ID.test(termId) || !OBJECT_ID.test(classId)) return null;
  const row = await FeeStructureModel.findOne({ termId, classId, status: FEE_STRUCTURE_STATUS.APPROVED }).lean<Row>();
  return row ? toRecord(row) : null;
}

/** Only a draft can change. An approved structure is frozen. */
async function updateDraft(id: string, patch: { name?: string; items?: FeeItem[]; totalKobo?: number }): Promise<FeeStructureRecord | null> {
  const row = await FeeStructureModel.findOneAndUpdate(
    { _id: id, status: FEE_STRUCTURE_STATUS.DRAFT }, { $set: patch }, { new: true, runValidators: true },
  ).lean<Row>();
  return row ? toRecord(row) : null;
}

async function transition(id: string, from: FeeStructureStatus, to: FeeStructureStatus, approval: { by: string; at: Date } | null): Promise<FeeStructureRecord | null> {
  const row = await FeeStructureModel.findOneAndUpdate(
    { _id: id, status: from },
    { $set: { status: to, approvedBy: approval?.by ?? null, approvedAt: approval?.at ?? null } },
    { new: true },
  ).lean<Row>();
  return row ? toRecord(row) : null;
}

async function list(filter: { termId?: string | undefined; classId?: string | undefined; status?: FeeStructureStatus | undefined }, o: { page: number; limit: number }) {
  const query: Record<string, unknown> = {};
  for (const key of ['termId', 'classId', 'status'] as const) if (filter[key] !== undefined) query[key] = filter[key];
  const [rows, total] = await Promise.all([
    FeeStructureModel.find(query).sort({ createdAt: -1, _id: -1 }).skip(skipOf(o.page, o.limit)).limit(o.limit).lean<Row[]>(),
    FeeStructureModel.countDocuments(query),
  ]);
  return { items: rows.map(toRecord), total };
}

export const feeStructureRepository = { create, findById, findApproved, updateDraft, transition, list };