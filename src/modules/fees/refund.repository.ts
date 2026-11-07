import mongoose, { type ClientSession, type Model, type Types } from 'mongoose';
import { isDuplicateKeyError } from '../../common/utils/mongoErrors';
import { skipOf } from '../../common/utils/pagination';

export const REFUND_STATUS = { REQUESTED: 'REQUESTED', PENDING: 'PENDING', PROCESSED: 'PROCESSED', FAILED: 'FAILED', UNCERTAIN: 'UNCERTAIN' } as const;
export type RefundStatus = (typeof REFUND_STATUS)[keyof typeof REFUND_STATUS];
/** These hold back part of the payment, so the same money can never be refunded twice. */
export const OPEN_REFUND: RefundStatus[] = [REFUND_STATUS.REQUESTED, REFUND_STATUS.PENDING, REFUND_STATUS.UNCERTAIN];

interface RefundDocument {
  paymentId: Types.ObjectId; requestId: Types.ObjectId; amountKobo: number; status: RefundStatus;
  providerRefundId: string | null; failureReason: string | null; createdBy: Types.ObjectId | null; createdAt: Date; processedAt: Date | null;
}
type Row = RefundDocument & { _id: Types.ObjectId };

const schema = new mongoose.Schema<RefundDocument>(
  {
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', required: true },
    requestId: { type: mongoose.Schema.Types.ObjectId, required: true },
    amountKobo: { type: Number, required: true, min: 1 },
    status: { type: String, enum: Object.values(REFUND_STATUS), required: true },
    providerRefundId: { type: String, default: null },
    failureReason: { type: String, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    processedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
schema.index({ requestId: 1 }, { unique: true }); // one refund per approved request
schema.index({ paymentId: 1, status: 1 });
schema.index({ status: 1, createdAt: 1 });

const RefundModel: Model<RefundDocument> =
  (mongoose.models.Refund as Model<RefundDocument> | undefined) ?? mongoose.model<RefundDocument>('Refund', schema);

export interface RefundRecord {
  id: string; paymentId: string; requestId: string; amountKobo: number; status: RefundStatus;
  providerRefundId: string | null; failureReason: string | null; createdBy: string | null; createdAt: Date;
}
const OBJECT_ID = /^[a-f0-9]{24}$/;
const toRecord = (r: Row): RefundRecord => ({
  id: r._id.toString(), paymentId: r.paymentId.toString(), requestId: r.requestId.toString(), amountKobo: r.amountKobo, status: r.status,
  providerRefundId: r.providerRefundId ?? null, failureReason: r.failureReason ?? null, createdBy: r.createdBy ? r.createdBy.toString() : null, createdAt: r.createdAt,
});

/** Null means this request already has a refund. */
async function create(data: { paymentId: string; requestId: string; amountKobo: number; createdBy: string | null }): Promise<RefundRecord | null> {
  try {
    const doc = await RefundModel.create({ ...data, status: REFUND_STATUS.REQUESTED });
    return toRecord(doc.toObject() as Row);
  } catch (err) {
    if (isDuplicateKeyError(err)) return null;
    throw err;
  }
}

async function findById(id: string): Promise<RefundRecord | null> {
  if (!OBJECT_ID.test(id)) return null;
  const row = await RefundModel.findById(id).lean<Row>();
  return row ? toRecord(row) : null;
}

async function change(id: string, from: RefundStatus[], set: Record<string, unknown>, session?: ClientSession): Promise<RefundRecord | null> {
  const row = await RefundModel.findOneAndUpdate({ _id: id, status: { $in: from } }, { $set: set }, { new: true, ...(session ? { session } : {}) }).lean<Row>();
  return row ? toRecord(row) : null;
}

const markPending = (id: string, providerRefundId: string) =>
  change(id, [REFUND_STATUS.REQUESTED, REFUND_STATUS.UNCERTAIN, REFUND_STATUS.PENDING], { status: REFUND_STATUS.PENDING, providerRefundId });
const markUncertain = (id: string, note: string) => change(id, [REFUND_STATUS.REQUESTED], { status: REFUND_STATUS.UNCERTAIN, failureReason: note.slice(0, 200) });
const markFailed = (id: string, reason: string) => change(id, OPEN_REFUND, { status: REFUND_STATUS.FAILED, failureReason: reason.slice(0, 200) });
const markProcessed = (id: string, session: ClientSession) => change(id, OPEN_REFUND, { status: REFUND_STATUS.PROCESSED, processedAt: new Date() }, session);

async function reservedTotal(paymentId: string): Promise<number> {
  if (!OBJECT_ID.test(paymentId)) return 0;
  const [row] = await RefundModel.aggregate<{ _id: null; total: number }>([
    { $match: { paymentId: new mongoose.Types.ObjectId(paymentId), status: { $in: OPEN_REFUND } } },
    { $group: { _id: null, total: { $sum: '$amountKobo' } } },
  ]);
  return row?.total ?? 0;
}

async function openForPayment(paymentId: string): Promise<RefundRecord[]> {
  if (!OBJECT_ID.test(paymentId)) return [];
  return (await RefundModel.find({ paymentId, status: { $in: OPEN_REFUND } }).sort({ createdAt: 1 }).lean<Row[]>()).map(toRecord);
}

async function pendingOlderThan(date: Date, limit: number): Promise<RefundRecord[]> {
  return (await RefundModel.find({ status: REFUND_STATUS.PENDING, createdAt: { $lt: date } }).sort({ createdAt: 1 }).limit(limit).lean<Row[]>()).map(toRecord);
}

async function list(filter: { status?: RefundStatus | undefined }, o: { page: number; limit: number }) {
  const query: Record<string, unknown> = filter.status ? { status: filter.status } : {};
  const [rows, total] = await Promise.all([
    RefundModel.find(query).sort({ createdAt: -1, _id: -1 }).skip(skipOf(o.page, o.limit)).limit(o.limit).lean<Row[]>(),
    RefundModel.countDocuments(query),
  ]);
  return { items: rows.map(toRecord), total };
}

export const refundRepository = { create, findById, markPending, markUncertain, markFailed, markProcessed, reservedTotal, openForPayment, pendingOlderThan, list };