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
  providerStatus: string | null; providerTransactionId: string | null; checkoutUrl: string | null; failureReason: string | null; verifiedAt: Date | null;
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
    checkoutUrl: { type: String, default: null }, failureReason: { type: String, default: null }, verifiedAt: { type: Date, default: null },
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
  refundedKobo: number; reverseReason: string | null; note: string | null; idemHash: string | null; checkoutUrl: string | null; createdAt: Date;
}

const OBJECT_ID = /^[a-f0-9]{24}$/;
const toRecord = (r: Row): PaymentRecord => ({
  id: r._id.toString(), reference: r.reference, invoiceId: r.invoiceId.toString(), studentId: r.studentId.toString(),
  payerId: r.payerId ? r.payerId.toString() : null, recordedBy: r.recordedBy ? r.recordedBy.toString() : null,
  method: r.method, status: r.status, amountKobo: r.amountKobo, feeKobo: r.feeKobo, totalChargeKobo: r.totalChargeKobo,
  externalReference: r.externalReference ?? null, receiptNo: r.receiptNo ?? null, paidAt: r.paidAt ?? null,
  balanceAfterKobo: r.balanceAfterKobo ?? null, refundedKobo: r.refundedKobo ?? 0, reverseReason: r.reverseReason ?? null,
  note: r.note ?? null, idemHash: r.idemHash ?? null, checkoutUrl: r.checkoutUrl ?? null, createdAt: r.createdAt,
});

/** The id is made first, because the ledger entry needs it before the payment document exists. */
const newId = (): string => new mongoose.Types.ObjectId().toString();
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

export const paymentRepository = {
  newId, createOffline, findById, findByReference, findByIdempotency, list, listForInvoices, markReversed, addRefund,
};