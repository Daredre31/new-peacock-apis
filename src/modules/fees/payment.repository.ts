import { randomBytes } from 'node:crypto';
import mongoose, { type ClientSession, type Model, type Types } from 'mongoose';
import { skipOf } from '../../common/utils/pagination';
import { nextSequence } from '../users/counter.model';

export const PAYMENT_STATUS = {
  PENDING: 'PENDING', SUCCESS: 'SUCCESS', FAILED: 'FAILED', ABANDONED: 'ABANDONED', NEEDS_REVIEW: 'NEEDS_REVIEW', REVERSED: 'REVERSED',
} as const;
export type PaymentStatus = (typeof PAYMENT_STATUS)[keyof typeof PAYMENT_STATUS];
export const PAYMENT_METHODS = ['ONLINE', 'CASH', 'TRANSFER', 'POS'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type OfflineMethod = Exclude<PaymentMethod, 'ONLINE'>;

interface PaymentDocument {
  reference: string; invoiceId: Types.ObjectId; studentId: Types.ObjectId; payerId: Types.ObjectId | null; recordedBy: Types.ObjectId | null;
  method: PaymentMethod; status: PaymentStatus;
  /** What this payment takes off the invoice. */
  amountKobo: number;
  /** The online fee the parent paid on top. It does not reduce the invoice. */
  feeKobo: number;
  /** amountKobo + feeKobo: what the parent is actually charged. */
  totalChargeKobo: number;
  currency: 'NGN';
  externalReference?: string; idemScope?: string; idemKey?: string; idemHash?: string; receiptNo?: string;
  paidAt: Date | null; balanceAfterKobo: number | null; refundedKobo: number;
  reversedAt: Date | null; reversedBy: Types.ObjectId | null; reverseReason: string | null; note: string | null;
  providerStatus: string | null; providerTransactionId: string | null; checkoutUrl: string | null; failureReason: string | null;
  lastVerifyAt: Date | null;
  verifiedAt: Date | null;
  accessCode: string | null;
  createdAt: Date; updatedAt: Date;
}
type Row = PaymentDocument & { _id: Types.ObjectId };

const oid = (ref: string, required = true) => ({ type: mongoose.Schema.Types.ObjectId, ref, required });
const schema = new mongoose.Schema<PaymentDocument>(
  {
    reference: { type: String, required: true },
    invoiceId: oid('Invoice'), studentId: oid('User'),
    payerId: { type: mongoose.Schema.Types.ObjectId, default: null }, recordedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    method: { type: String, enum: PAYMENT_METHODS, required: true },
    status: { type: String, enum: Object.values(PAYMENT_STATUS), required: true },
    amountKobo: { type: Number, required: true, min: 1 }, feeKobo: { type: Number, default: 0, min: 0 },
    totalChargeKobo: { type: Number, required: true, min: 1 }, currency: { type: String, default: 'NGN' },
    externalReference: { type: String, default: undefined }, idemScope: { type: String, default: undefined },
    idemKey: { type: String, default: undefined }, idemHash: { type: String, default: undefined }, receiptNo: { type: String, default: undefined },
    paidAt: { type: Date, default: null }, balanceAfterKobo: { type: Number, default: null }, refundedKobo: { type: Number, default: 0 },
    reversedAt: { type: Date, default: null }, reversedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    reverseReason: { type: String, default: null }, note: { type: String, default: null, maxlength: 300 },
    providerStatus: { type: String, default: null }, providerTransactionId: { type: String, default: null },
    checkoutUrl: { type: String, default: null }, failureReason: { type: String, default: null }, 
    accessCode: { type: String, default: null }, lastVerifyAt: { type: Date, default: null },
    verifiedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);
schema.index({ reference: 1 }, { unique: true });
schema.index({ receiptNo: 1 }, { unique: true, partialFilterExpression: { receiptNo: { $type: 'string' } } });
// The same bank transfer or POS slip can only be recorded once.
schema.index({ externalReference: 1 }, { unique: true, partialFilterExpression: { externalReference: { $type: 'string' } } });
schema.index({ idemScope: 1, idemKey: 1 }, { unique: true, partialFilterExpression: { idemKey: { $type: 'string' } } });
schema.index({ invoiceId: 1, createdAt: -1 });
schema.index({ studentId: 1, createdAt: -1 });
schema.index({ status: 1, createdAt: 1 });

const PaymentModel: Model<PaymentDocument> =
  (mongoose.models.Payment as Model<PaymentDocument> | undefined) ?? mongoose.model<PaymentDocument>('Payment', schema);

export interface PaymentRecord {
  id: string; reference: string; invoiceId: string; studentId: string; payerId: string | null; recordedBy: string | null;
  method: PaymentMethod; status: PaymentStatus; amountKobo: number; feeKobo: number; totalChargeKobo: number;
  externalReference: string | null; receiptNo: string | null; paidAt: Date | null; balanceAfterKobo: number | null;
  refundedKobo: number; reverseReason: string | null; note: string | null; idemHash: string | null; checkoutUrl: string | null;
  providerStatus: string | null; failureReason: string | null; lastVerifyAt: Date | null; createdAt: Date;
}

const OBJECT_ID = /^[a-f0-9]{24}$/;
const toRecord = (r: Row): PaymentRecord => ({
  id: r._id.toString(), reference: r.reference, invoiceId: r.invoiceId.toString(), studentId: r.studentId.toString(),
  payerId: r.payerId ? r.payerId.toString() : null, recordedBy: r.recordedBy ? r.recordedBy.toString() : null,
  method: r.method, status: r.status, amountKobo: r.amountKobo, feeKobo: r.feeKobo, totalChargeKobo: r.totalChargeKobo,
  externalReference: r.externalReference ?? null, receiptNo: r.receiptNo ?? null, paidAt: r.paidAt ?? null,
  balanceAfterKobo: r.balanceAfterKobo ?? null, refundedKobo: r.refundedKobo ?? 0, reverseReason: r.reverseReason ?? null,
  note: r.note ?? null, idemHash: r.idemHash ?? null, checkoutUrl: r.checkoutUrl ?? null,
  providerStatus: r.providerStatus ?? null, failureReason: r.failureReason ?? null, lastVerifyAt: r.lastVerifyAt ?? null, createdAt: r.createdAt,
});

/** The id is made first, because the ledger entry needs it before the payment document exists. */
const newId = (): string => new mongoose.Types.ObjectId().toString();
export const ONLINE_REFERENCE_PREFIX = 'PCK-';
const newOnlineReference = (): string => `${ONLINE_REFERENCE_PREFIX}${randomBytes(10).toString('hex').toUpperCase()}`;
const newReference = (prefix: string): string => `${prefix}-${randomBytes(10).toString('hex').toUpperCase()}`;

export async function nextReceiptNo(session: ClientSession): Promise<string> {
  return `RCT-${String(await nextSequence('receipt', session)).padStart(6, '0')}`;
}

async function createOffline(
  data: {
    id: string; invoiceId: string; studentId: string; recordedBy: string; method: OfflineMethod; amountKobo: number;
    externalReference?: string; paidAt: Date; balanceAfterKobo: number; note: string | null; idemScope: string; idemKey: string; idemHash: string;
  },
  session: ClientSession,
): Promise<PaymentRecord> {
  const { id, ...rest } = data;
  const [doc] = await PaymentModel.create(
    [{
      ...rest, _id: id, reference: newReference('OFF'), status: PAYMENT_STATUS.SUCCESS, feeKobo: 0, totalChargeKobo: data.amountKobo,
      receiptNo: await nextReceiptNo(session),
    }],
    { session },
  );
  if (!doc) throw new Error('Payment was not created');
  return toRecord(doc.toObject() as Row);
}

async function findById(id: string, session?: ClientSession): Promise<PaymentRecord | null> {
  if (!OBJECT_ID.test(id)) return null;
  const row = await PaymentModel.findById(id, null, session ? { session } : {}).lean<Row>();
  return row ? toRecord(row) : null;
}

async function findByReference(reference: string): Promise<PaymentRecord | null> {
  const row = await PaymentModel.findOne({ reference }).lean<Row>();
  return row ? toRecord(row) : null;
}

async function findByIdempotency(scope: string, key: string): Promise<PaymentRecord | null> {
  const row = await PaymentModel.findOne({ idemScope: scope, idemKey: key }).lean<Row>();
  return row ? toRecord(row) : null;
}

export interface PaymentFilter {
  invoiceId?: string | undefined; studentId?: string | undefined; studentIds?: string[] | undefined;
  status?: PaymentStatus | undefined; method?: PaymentMethod | undefined; from?: Date | undefined; to?: Date | undefined;
}

async function list(filter: PaymentFilter, o: { page: number; limit: number }) {
  if (filter.studentIds && filter.studentIds.length === 0) return { items: [], total: 0 };
  const query: Record<string, unknown> = {};
  for (const key of ['invoiceId', 'studentId', 'status', 'method'] as const) if (filter[key] !== undefined) query[key] = filter[key];
  if (filter.studentIds) query.studentId = filter.studentId ? filter.studentId : { $in: filter.studentIds };
  if (filter.from || filter.to) query.createdAt = { ...(filter.from ? { $gte: filter.from } : {}), ...(filter.to ? { $lte: filter.to } : {}) };

  const [rows, total] = await Promise.all([
    PaymentModel.find(query).sort({ createdAt: -1, _id: -1 }).skip(skipOf(o.page, o.limit)).limit(o.limit).lean<Row[]>(),
    PaymentModel.countDocuments(query),
  ]);
  return { items: rows.map(toRecord), total };
}

async function listForInvoices(invoiceIds: string[]): Promise<PaymentRecord[]> {
  const ids = invoiceIds.filter((id) => OBJECT_ID.test(id));
  if (ids.length === 0) return [];
  return (await PaymentModel.find({ invoiceId: { $in: ids } }).sort({ createdAt: 1 }).lean<Row[]>()).map(toRecord);
}

/** Only a successful payment can be reversed, and only once. */
async function markReversed(id: string, by: string, reason: string, now: Date, session: ClientSession): Promise<PaymentRecord | null> {
  const row = await PaymentModel.findOneAndUpdate(
    { _id: id, status: PAYMENT_STATUS.SUCCESS, refundedKobo: 0 },
    { $set: { status: PAYMENT_STATUS.REVERSED, reversedAt: now, reversedBy: by, reverseReason: reason } },
    { new: true, session },
  ).lean<Row>();
  return row ? toRecord(row) : null;
}

/** Records a refund against a payment, only if what has been refunded so far is still what the caller saw. */
async function addRefund(id: string, expectedRefunded: number, amount: number, session: ClientSession): Promise<PaymentRecord | null> {
  const row = await PaymentModel.findOneAndUpdate(
    { _id: id, status: PAYMENT_STATUS.SUCCESS, refundedKobo: expectedRefunded, amountKobo: { $gte: expectedRefunded + amount } },
    { $inc: { refundedKobo: amount } },
    { new: true, session },
  ).lean<Row>();
  return row ? toRecord(row) : null;
}

const ONLINE_OPEN: PaymentStatus[] = [PAYMENT_STATUS.PENDING, PAYMENT_STATUS.ABANDONED, PAYMENT_STATUS.FAILED];

/** Written BEFORE Paystack is called, so a crash or timeout can never lose track of a payment. */
async function createPending(data: { id: string; reference: string; invoiceId: string; studentId: string; payerId: string; amountKobo: number; feeKobo: number; idemScope: string; idemKey: string; idemHash: string }): Promise<PaymentRecord> {
  const { id, ...rest } = data;
  const doc = await PaymentModel.create({ ...rest, _id: id, method: 'ONLINE', status: PAYMENT_STATUS.PENDING, totalChargeKobo: data.amountKobo + data.feeKobo });
  return toRecord(doc.toObject() as Row);
}

async function setCheckout(id: string, checkoutUrl: string, accessCode: string): Promise<void> {
  await PaymentModel.updateOne({ _id: id, status: PAYMENT_STATUS.PENDING }, { $set: { checkoutUrl, accessCode } });
}

async function markFailed(id: string, reason: string, providerStatus: string | null): Promise<PaymentRecord | null> {
  const row = await PaymentModel.findOneAndUpdate(
    { _id: id, status: { $in: [PAYMENT_STATUS.PENDING, PAYMENT_STATUS.ABANDONED] } },
    { $set: { status: PAYMENT_STATUS.FAILED, failureReason: reason.slice(0, 200), providerStatus } }, { new: true },
  ).lean<Row>();
  return row ? toRecord(row) : null;
}

async function markAbandoned(id: string): Promise<boolean> {
  return (await PaymentModel.updateOne({ _id: id, status: PAYMENT_STATUS.PENDING }, { $set: { status: PAYMENT_STATUS.ABANDONED } })).matchedCount > 0;
}

async function markNeedsReview(id: string, reason: string, providerStatus: string | null): Promise<PaymentRecord | null> {
  const row = await PaymentModel.findOneAndUpdate(
    { _id: id, status: { $in: ONLINE_OPEN } },
    { $set: { status: PAYMENT_STATUS.NEEDS_REVIEW, failureReason: reason.slice(0, 200), providerStatus } }, { new: true },
  ).lean<Row>();
  return row ? toRecord(row) : null;
}

/** Only one caller per interval gets to ask Paystack, so polling can never hammer it. */
async function claimVerify(id: string, minGapMs: number, now: Date): Promise<boolean> {
  const cutoff = new Date(now.getTime() - minGapMs);
  const row = await PaymentModel.findOneAndUpdate(
    { _id: id, status: { $in: ONLINE_OPEN }, $or: [{ lastVerifyAt: null }, { lastVerifyAt: { $lt: cutoff } }] },
    { $set: { lastVerifyAt: now } },
  ).lean<Row>();
  return row !== null;
}

/**
 * Moves a payment to SUCCESS. Only a payment that is still pending, abandoned or failed can move,
 * so a late success is still credited and a payment can never be credited twice. Runs in the caller's transaction.
 */
async function claimSuccess(id: string, data: { transactionId: string; paidAt: Date }, session: ClientSession): Promise<PaymentRecord | null> {
  const row = await PaymentModel.findOneAndUpdate(
    { _id: id, method: 'ONLINE', status: { $in: ONLINE_OPEN } },
    { $set: { status: PAYMENT_STATUS.SUCCESS, paidAt: data.paidAt, providerStatus: 'success', providerTransactionId: data.transactionId, verifiedAt: new Date(), failureReason: null } },
    { new: true, session },
  ).lean<Row>();
  if (!row) return null;
  const receiptNo = await nextReceiptNo(session); // taken only after the claim won, so there are no gaps
  await PaymentModel.updateOne({ _id: id }, { $set: { receiptNo } }, { session });
  return toRecord({ ...row, receiptNo });
}

async function setBalanceAfter(id: string, balanceKobo: number, session: ClientSession): Promise<void> {
  await PaymentModel.updateOne({ _id: id }, { $set: { balanceAfterKobo: balanceKobo } }, { session });
}

async function listPendingForSweep(olderThan: Date, verifiedBefore: Date, limit: number): Promise<PaymentRecord[]> {
  const rows = await PaymentModel.find({
    method: 'ONLINE', status: PAYMENT_STATUS.PENDING, createdAt: { $lt: olderThan },
    $or: [{ lastVerifyAt: null }, { lastVerifyAt: { $lt: verifiedBefore } }],
  }).sort({ createdAt: 1 }).limit(limit).lean<Row[]>();
  return rows.map(toRecord);
}

async function listOpenForInvoice(invoiceId: string): Promise<PaymentRecord[]> {
  if (!OBJECT_ID.test(invoiceId)) return [];
  return (await PaymentModel.find({ invoiceId, method: 'ONLINE', status: PAYMENT_STATUS.PENDING }).sort({ createdAt: -1 }).lean<Row[]>()).map(toRecord);
}

async function listSuccessfulOnlineBetween(from: Date, to: Date): Promise<PaymentRecord[]> {
  const rows = await PaymentModel.find({ method: 'ONLINE', status: { $in: [PAYMENT_STATUS.SUCCESS, PAYMENT_STATUS.REVERSED] }, paidAt: { $gte: from, $lte: to } }).limit(5000).lean<Row[]>();
  return rows.map(toRecord);
}

async function sumByMethod(invoiceIds: string[]): Promise<{ method: PaymentMethod; totalKobo: number; count: number }[]> {
  const ids = invoiceIds.filter((id) => OBJECT_ID.test(id)).map((id) => new mongoose.Types.ObjectId(id));
  if (ids.length === 0) return [];
  const rows = await PaymentModel.aggregate<{ _id: PaymentMethod; totalKobo: number; count: number }>([
    { $match: { invoiceId: { $in: ids }, status: PAYMENT_STATUS.SUCCESS } },
    { $group: { _id: '$method', totalKobo: { $sum: { $subtract: ['$amountKobo', '$refundedKobo'] } }, count: { $sum: 1 } } },
  ]);
  return rows.map((r) => ({ method: r._id, totalKobo: r.totalKobo, count: r.count }));
}

async function collectedBetween(from: Date, to: Date): Promise<number> {
  const [row] = await PaymentModel.aggregate<{ _id: null; total: number }>([
    { $match: { status: PAYMENT_STATUS.SUCCESS, paidAt: { $gte: from, $lte: to } } },
    { $group: { _id: null, total: { $sum: { $subtract: ['$amountKobo', '$refundedKobo'] } } } },
  ]);
  return row?.total ?? 0;
}

async function monthlyRevenue(from: Date, to: Date): Promise<{ month: string; method: PaymentMethod; totalKobo: number; count: number }[]> {
  const rows = await PaymentModel.aggregate<{ _id: { month: string; method: PaymentMethod }; totalKobo: number; count: number }>([
    { $match: { status: PAYMENT_STATUS.SUCCESS, paidAt: { $gte: from, $lte: to } } },
    { $group: { _id: { month: { $dateToString: { format: '%Y-%m', date: '$paidAt', timezone: 'Africa/Lagos' } }, method: '$method' }, totalKobo: { $sum: { $subtract: ['$amountKobo', '$refundedKobo'] } }, count: { $sum: 1 } } },
    { $sort: { '_id.month': 1 } },
  ]);
  return rows.map((r) => ({ month: r._id.month, method: r._id.method, totalKobo: r.totalKobo, count: r.count }));
}

export const paymentRepository = {
  newId, createOffline, findById, findByReference, findByIdempotency, list, listForInvoices, markReversed, addRefund,
  newOnlineReference, createPending, setCheckout, markFailed, markAbandoned, 
  markNeedsReview, claimVerify, claimSuccess, setBalanceAfter, listPendingForSweep, listOpenForInvoice, listSuccessfulOnlineBetween,
   sumByMethod, collectedBetween, monthlyRevenue
};