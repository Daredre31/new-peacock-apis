import mongoose, { type Model, type Types } from 'mongoose';
import { skipOf } from '../../common/utils/pagination';
import type { FeeItem } from './feeStructure.repository';

export const FEE_CHARGE_STATUS = { DRAFT: 'DRAFT', APPROVED: 'APPROVED' } as const;
export type FeeChargeStatus = (typeof FEE_CHARGE_STATUS)[keyof typeof FEE_CHARGE_STATUS];

/** Who is billed: every student in a class, every student in one arm, or a hand-picked list. */
export type Audience =
  | { kind: 'CLASS'; classId: string }
  | { kind: 'ARM'; classArmId: string }
  | { kind: 'STUDENTS'; studentIds: string[] };

interface FeeChargeDocument {
  title: string; termId: Types.ObjectId; sessionId: Types.ObjectId;
  items: FeeItem[]; totalKobo: number; dueDate: string; blocksReports: boolean;
  audienceKind: Audience['kind']; classId: Types.ObjectId | null; classArmId: Types.ObjectId | null; studentIds: Types.ObjectId[];
  status: FeeChargeStatus; createdBy: Types.ObjectId; approvedBy: Types.ObjectId | null; approvedAt: Date | null;
  issuedAt: Date | null; createdAt: Date; updatedAt: Date;
}
type Row = FeeChargeDocument & { _id: Types.ObjectId };

const itemSchema = new mongoose.Schema(
  { name: { type: String, required: true, maxlength: 60 }, amountKobo: { type: Number, required: true, min: 1 } },
  { _id: false },
);
const ref = (to: string) => ({ type: mongoose.Schema.Types.ObjectId, ref: to, default: null });
const schema = new mongoose.Schema<FeeChargeDocument>(
  {
    title: { type: String, required: true, maxlength: 100 },
    termId: { type: mongoose.Schema.Types.ObjectId, ref: 'Term', required: true },
    sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', required: true },
    items: { type: [itemSchema], required: true },
    totalKobo: { type: Number, required: true, min: 1 },
    dueDate: { type: String, required: true },
    blocksReports: { type: Boolean, default: false },
    audienceKind: { type: String, enum: ['CLASS', 'ARM', 'STUDENTS'], required: true },
    classId: ref('Class'), classArmId: ref('ClassArm'),
    studentIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    status: { type: String, enum: Object.values(FEE_CHARGE_STATUS), default: FEE_CHARGE_STATUS.DRAFT },
    createdBy: { type: mongoose.Schema.Types.ObjectId, required: true },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    approvedAt: { type: Date, default: null },
    issuedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);
schema.index({ termId: 1, status: 1, createdAt: -1 });
schema.index({ status: 1, createdAt: -1 });

const FeeChargeModel: Model<FeeChargeDocument> =
  (mongoose.models.FeeCharge as Model<FeeChargeDocument> | undefined) ?? mongoose.model<FeeChargeDocument>('FeeCharge', schema);

export interface FeeChargeRecord {
  id: string; title: string; termId: string; sessionId: string; items: FeeItem[]; totalKobo: number; dueDate: string; blocksReports: boolean;
  audience: Audience; status: FeeChargeStatus; createdBy: string; approvedAt: Date | null; issuedAt: Date | null; createdAt: Date;
}

const OBJECT_ID = /^[a-f0-9]{24}$/;
function audienceOf(r: Row): Audience {
  if (r.audienceKind === 'CLASS') return { kind: 'CLASS', classId: String(r.classId) };
  if (r.audienceKind === 'ARM') return { kind: 'ARM', classArmId: String(r.classArmId) };
  return { kind: 'STUDENTS', studentIds: r.studentIds.map(String) };
}
const toRecord = (r: Row): FeeChargeRecord => ({
  id: r._id.toString(), title: r.title, termId: r.termId.toString(), sessionId: r.sessionId.toString(),
  items: r.items.map((i) => ({ name: i.name, amountKobo: i.amountKobo })), totalKobo: r.totalKobo, dueDate: r.dueDate,
  blocksReports: r.blocksReports, audience: audienceOf(r), status: r.status, createdBy: r.createdBy.toString(),
  approvedAt: r.approvedAt ?? null, issuedAt: r.issuedAt ?? null, createdAt: r.createdAt,
});
const audienceFields = (a: Audience) => ({
  audienceKind: a.kind,
  classId: a.kind === 'CLASS' ? a.classId : null,
  classArmId: a.kind === 'ARM' ? a.classArmId : null,
  studentIds: a.kind === 'STUDENTS' ? a.studentIds : [],
});

export interface NewCharge {
  title: string; termId: string; sessionId: string; items: FeeItem[]; totalKobo: number; dueDate: string;
  blocksReports: boolean; audience: Audience; createdBy: string;
}

async function create(data: NewCharge): Promise<FeeChargeRecord> {
  const { audience, ...rest } = data;
  const doc = await FeeChargeModel.create({ ...rest, ...audienceFields(audience) });
  return toRecord(doc.toObject() as Row);
}

async function findById(id: string): Promise<FeeChargeRecord | null> {
  if (!OBJECT_ID.test(id)) return null;
  const row = await FeeChargeModel.findById(id).lean<Row>();
  return row ? toRecord(row) : null;
}

async function list(filter: { termId?: string | undefined; status?: FeeChargeStatus | undefined }, o: { page: number; limit: number }) {
  const query: Record<string, unknown> = {};
  if (filter.termId) query.termId = filter.termId;
  if (filter.status) query.status = filter.status;
  const [rows, total] = await Promise.all([
    FeeChargeModel.find(query).sort({ createdAt: -1, _id: -1 }).skip(skipOf(o.page, o.limit)).limit(o.limit).lean<Row[]>(),
    FeeChargeModel.countDocuments(query),
  ]);
  return { items: rows.map(toRecord), total };
}

/** Only while the charge is still a draft. Returns null when it was approved in the meantime. */
async function updateDraft(
  id: string,
  patch: Partial<Pick<NewCharge, 'title' | 'items' | 'totalKobo' | 'dueDate' | 'blocksReports' | 'audience'>>,
): Promise<FeeChargeRecord | null> {
  if (!OBJECT_ID.test(id)) return null;
  const { audience, ...rest } = patch;
  const row = await FeeChargeModel.findOneAndUpdate(
    { _id: id, status: FEE_CHARGE_STATUS.DRAFT },
    { $set: { ...rest, ...(audience ? audienceFields(audience) : {}) } },
    { new: true },
  ).lean<Row>();
  return row ? toRecord(row) : null;
}

async function deleteDraft(id: string): Promise<boolean> {
  if (!OBJECT_ID.test(id)) return false;
  return (await FeeChargeModel.deleteOne({ _id: id, status: FEE_CHARGE_STATUS.DRAFT })).deletedCount === 1;
}

/** Moves between DRAFT and APPROVED atomically. Reopening also requires that nothing was issued. */
async function transition(id: string, from: FeeChargeStatus, to: FeeChargeStatus, approval: { by: string; at: Date } | null): Promise<FeeChargeRecord | null> {
  if (!OBJECT_ID.test(id)) return null;
  const filter: Record<string, unknown> = { _id: id, status: from };
  if (to === FEE_CHARGE_STATUS.DRAFT) filter.issuedAt = null;
  const row = await FeeChargeModel.findOneAndUpdate(
    filter, { $set: { status: to, approvedBy: approval?.by ?? null, approvedAt: approval?.at ?? null } }, { new: true },
  ).lean<Row>();
  return row ? toRecord(row) : null;
}

/** Remembers when the first invoices went out, so an issued charge can never be reopened. */
async function markIssued(id: string, at: Date): Promise<void> {
  if (OBJECT_ID.test(id)) await FeeChargeModel.updateOne({ _id: id, issuedAt: null }, { $set: { issuedAt: at } });
}

export const feeChargeRepository = { create, findById, list, updateDraft, deleteDraft, transition, markIssued };
