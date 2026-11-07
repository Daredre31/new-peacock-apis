import mongoose, { type ClientSession, type Model, type Types } from 'mongoose';

/**
 * Sign convention: positive means the family owes more, negative means they owe less.
 * INVOICE +total, PAYMENT -amount, WAIVER -amount, REFUND +amount, PAYMENT_REVERSAL +amount.
 */
export const LEDGER_TYPES = ['INVOICE', 'PAYMENT', 'WAIVER', 'REFUND', 'ADJUSTMENT', 'PAYMENT_REVERSAL'] as const;
export type LedgerType = (typeof LEDGER_TYPES)[number];

interface LedgerDocument {
  invoiceId: Types.ObjectId; studentId: Types.ObjectId; type: LedgerType; amountKobo: number;
  paymentId?: Types.ObjectId; requestId?: Types.ObjectId; refPaymentId?: Types.ObjectId;
  note: string | null; createdBy: Types.ObjectId | null; createdAt: Date;
}
type Row = LedgerDocument & { _id: Types.ObjectId };

const MESSAGE = 'Ledger entries are append-only';
const schema = new mongoose.Schema<LedgerDocument>(
  {
    invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', required: true },
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: LEDGER_TYPES, required: true },
    amountKobo: { type: Number, required: true, validate: { validator: (v: unknown) => Number.isSafeInteger(v) && v !== 0, message: 'Must be a non-zero whole number of kobo' } },
    paymentId: { type: mongoose.Schema.Types.ObjectId, default: undefined },
    requestId: { type: mongoose.Schema.Types.ObjectId, default: undefined },
    refPaymentId: { type: mongoose.Schema.Types.ObjectId, default: undefined },
    note: { type: String, default: null, maxlength: 500 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
schema.index({ invoiceId: 1, createdAt: 1 });
schema.index({ studentId: 1, createdAt: -1 });
// The last line of defence: a payment can be credited once and reversed once, whatever the code does.
schema.index({ paymentId: 1, type: 1 }, { unique: true, partialFilterExpression: { paymentId: { $type: 'objectId' } } });
// A waiver or refund decision is applied once.
schema.index({ requestId: 1, type: 1 }, { unique: true, partialFilterExpression: { requestId: { $type: 'objectId' } } });
// One INVOICE entry per invoice.
schema.index({ invoiceId: 1 }, { unique: true, partialFilterExpression: { type: 'INVOICE' }, name: 'one_invoice_entry_per_invoice' });

const BLOCKED = ['updateOne', 'updateMany', 'replaceOne', 'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete', 'deleteOne', 'deleteMany'] as const;
schema.pre([...BLOCKED], function () { throw new Error(MESSAGE); });
schema.pre('save', function () { if (!this.isNew) throw new Error(MESSAGE); });

const LedgerModel: Model<LedgerDocument> =
  (mongoose.models.LedgerEntry as Model<LedgerDocument> | undefined) ?? mongoose.model<LedgerDocument>('LedgerEntry', schema);

export interface EntryInput {
  invoiceId: string; studentId: string; type: LedgerType; amountKobo: number;
  paymentId?: string; requestId?: string; refPaymentId?: string; note?: string | null; createdBy?: string | null;
}
export interface LedgerRecord {
  id: string; invoiceId: string; studentId: string; type: LedgerType; amountKobo: number;
  paymentId: string | null; requestId: string | null; refPaymentId: string | null; note: string | null; createdAt: Date;
}

const OBJECT_ID = /^[a-f0-9]{24}$/;
const toRecord = (r: Row): LedgerRecord => ({
  id: r._id.toString(), invoiceId: r.invoiceId.toString(), studentId: r.studentId.toString(), type: r.type, amountKobo: r.amountKobo,
  paymentId: r.paymentId ? r.paymentId.toString() : null, requestId: r.requestId ? r.requestId.toString() : null,
  refPaymentId: r.refPaymentId ? r.refPaymentId.toString() : null, note: r.note ?? null, createdAt: r.createdAt,
});

async function insert(entry: EntryInput, session: ClientSession): Promise<LedgerRecord> {
  const [doc] = await LedgerModel.create([{ ...entry }], { session });
  if (!doc) throw new Error('Ledger entry was not created');
  return toRecord(doc.toObject() as Row);
}

async function listForInvoice(invoiceId: string): Promise<LedgerRecord[]> {
  if (!OBJECT_ID.test(invoiceId)) return [];
  return (await LedgerModel.find({ invoiceId }).sort({ createdAt: 1, _id: 1 }).lean<Row[]>()).map(toRecord);
}

/** What the invoice balance must equal. Used to detect any drift between the ledger and the cached balance. */
async function sumForInvoice(invoiceId: string): Promise<number> {
  if (!OBJECT_ID.test(invoiceId)) return 0;
  const [row] = await LedgerModel.aggregate<{ _id: null; sum: number }>([
    { $match: { invoiceId: new mongoose.Types.ObjectId(invoiceId) } },
    { $group: { _id: null, sum: { $sum: '$amountKobo' } } },
  ]);
  return row?.sum ?? 0;
}

export const ledgerRepository = { insert, listForInvoice, sumForInvoice };