import mongoose, { type ClientSession, type Model, type Types } from 'mongoose';
import { skipOf } from '../../common/utils/pagination';
import { escapeRegex } from '../../common/utils/search';
import { nextSequence } from '../users/counter.model';
import type { FeeItem } from './feeStructure.repository';

export const INVOICE_STATUS = { UNPAID: 'UNPAID', PARTIALLY_PAID: 'PARTIALLY_PAID', PAID: 'PAID' } as const;
export type InvoiceStatus = (typeof INVOICE_STATUS)[keyof typeof INVOICE_STATUS];
/** NO_OVERPAY refuses a payment or waiver larger than the balance. */
export type BalanceGuard = 'ANY' | 'NO_OVERPAY';

export const statusFor = (total: number, balance: number): InvoiceStatus =>
  balance <= 0 ? INVOICE_STATUS.PAID : balance >= total ? INVOICE_STATUS.UNPAID : INVOICE_STATUS.PARTIALLY_PAID;

interface InvoiceDocument {
  number: string; studentId: Types.ObjectId; classId: Types.ObjectId; classArmId: Types.ObjectId; sessionId: Types.ObjectId;
  termId: Types.ObjectId; feeStructureId: Types.ObjectId; items: FeeItem[]; totalKobo: number;
  /** Cached sum of this invoice's ledger entries. The ledger is the truth; this is kept in step inside the same transaction. */
  balanceKobo: number;
  status: InvoiceStatus; dueDate: string; lastReminderAt: Date | null; createdBy: Types.ObjectId; createdAt: Date; updatedAt: Date;
  /** Set only on invoices that come from an extra charge. feeStructureId then holds the charge's id. */
  title?: string | null;
  /** False for extra charges that must not hold back report cards. Missing on older invoices, which means true. */
  blocksReports?: boolean;
}
type Row = InvoiceDocument & { _id: Types.ObjectId };

const itemSchema = new mongoose.Schema({ name: String, amountKobo: Number }, { _id: false });
const oid = (ref: string) => ({ type: mongoose.Schema.Types.ObjectId, ref, required: true });

const schema = new mongoose.Schema<InvoiceDocument>(
  {
    number: { type: String, required: true },
    studentId: oid('User'), classId: oid('Class'), classArmId: oid('ClassArm'), sessionId: oid('Session'),
    termId: oid('Term'), feeStructureId: oid('FeeStructure'),
    items: { type: [itemSchema], required: true },
    totalKobo: { type: Number, required: true, min: 1 },
    balanceKobo: { type: Number, required: true },
    status: { type: String, enum: Object.values(INVOICE_STATUS), required: true },
    dueDate: { type: String, required: true },
    lastReminderAt: { type: Date, default: null },
    title: { type: String, default: null, maxlength: 100 },
    blocksReports: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, required: true },
  },
  { timestamps: true, versionKey: false },
);
schema.index({ number: 1 }, { unique: true });
// Generating twice never creates a second invoice for the same student, term and fee structure.
schema.index({ studentId: 1, termId: 1, feeStructureId: 1 }, { unique: true });
schema.index({ termId: 1, classArmId: 1, status: 1 });
schema.index({ balanceKobo: 1, dueDate: 1 });
schema.index({ studentId: 1, createdAt: -1 });
schema.index({ feeStructureId: 1 });

const InvoiceModel: Model<InvoiceDocument> =
  (mongoose.models.Invoice as Model<InvoiceDocument> | undefined) ?? mongoose.model<InvoiceDocument>('Invoice', schema);

export interface InvoiceRecord {
  id: string; number: string; studentId: string; classId: string; classArmId: string; sessionId: string; termId: string;
  feeStructureId: string; items: FeeItem[]; totalKobo: number; balanceKobo: number; status: InvoiceStatus;
  dueDate: string; lastReminderAt: Date | null; createdAt: Date;
  /** The charge title for an extra charge, null for a term fee invoice. */
  title: string | null;
}
export type AdjustResult = { ok: true; invoice: InvoiceRecord } | { ok: false; reason: 'MISSING' | 'GUARD' };

const OBJECT_ID = /^[a-f0-9]{24}$/;
const toRecord = (r: Row): InvoiceRecord => ({
  id: r._id.toString(), number: r.number, studentId: r.studentId.toString(), classId: r.classId.toString(),
  classArmId: r.classArmId.toString(), sessionId: r.sessionId.toString(), termId: r.termId.toString(),
  feeStructureId: r.feeStructureId.toString(), items: r.items.map((i) => ({ name: i.name, amountKobo: i.amountKobo })),
  totalKobo: r.totalKobo, balanceKobo: r.balanceKobo, status: r.status, dueDate: r.dueDate,
  lastReminderAt: r.lastReminderAt ?? null, createdAt: r.createdAt, title: r.title ?? null,
});

export interface InvoiceFilter {
  termId?: string | undefined; classArmId?: string | undefined; status?: InvoiceStatus | undefined; studentId?: string | undefined;
  studentIds?: string[] | undefined; /** Only invoices with a balance whose due date is before this day. */ overdueBefore?: string | undefined; q?: string | undefined;
}
const SORTS = { '-createdAt': { createdAt: -1 }, dueDate: { dueDate: 1 }, '-balanceKobo': { balanceKobo: -1 } } as const;
export type InvoiceSort = keyof typeof SORTS;

function queryOf(filter: InvoiceFilter): Record<string, unknown> {
  const query: Record<string, unknown> = {};
  for (const key of ['termId', 'classArmId', 'status', 'studentId'] as const) if (filter[key] !== undefined) query[key] = filter[key];
  if (filter.studentIds) query.studentId = { $in: filter.studentIds };
  if (filter.overdueBefore) { query.balanceKobo = { $gt: 0 }; query.dueDate = { $lt: filter.overdueBefore }; }
  if (filter.q) query.number = { $regex: `^${escapeRegex(filter.q.toUpperCase())}` };
  return query;
}

async function create(
  data: { studentId: string; classId: string; classArmId: string; sessionId: string; termId: string; feeStructureId: string; items: FeeItem[]; totalKobo: number; dueDate: string; createdBy: string; title?: string; blocksReports?: boolean },
  session: ClientSession,
): Promise<InvoiceRecord> {
  const number = `INV-${String(await nextSequence('invoice', session)).padStart(6, '0')}`;
  const [doc] = await InvoiceModel.create(
    [{ ...data, number, balanceKobo: data.totalKobo, status: INVOICE_STATUS.UNPAID, lastReminderAt: null }], { session },
  );
  if (!doc) throw new Error('Invoice was not created');
  return toRecord(doc.toObject() as Row);
}

async function findById(id: string): Promise<InvoiceRecord | null> {
  if (!OBJECT_ID.test(id)) return null;
  const row = await InvoiceModel.findById(id).lean<Row>();
  return row ? toRecord(row) : null;
}

async function findManyByIds(ids: string[]): Promise<Map<string, InvoiceRecord>> {
  const valid = [...new Set(ids)].filter((id) => OBJECT_ID.test(id));
  if (valid.length === 0) return new Map();
  const rows = await InvoiceModel.find({ _id: { $in: valid } }).lean<Row[]>();
  return new Map(rows.map((r) => [r._id.toString(), toRecord(r)]));
}

async function list(filter: InvoiceFilter, o: { page: number; limit: number; sort: InvoiceSort }) {
  if (filter.studentIds && filter.studentIds.length === 0) return { items: [], total: 0 };
  const query = queryOf(filter);
  const [rows, total] = await Promise.all([
    InvoiceModel.find(query).sort({ ...SORTS[o.sort], _id: -1 }).skip(skipOf(o.page, o.limit)).limit(o.limit).lean<Row[]>(),
    InvoiceModel.countDocuments(query),
  ]);
  return { items: rows.map(toRecord), total };
}

/**
 * Moves the cached balance and recomputes the status. Runs inside the caller's transaction,
 * together with the ledger entry, so the two can never disagree.
 */
async function adjustBalance(id: string, delta: number, guard: BalanceGuard, session: ClientSession): Promise<AdjustResult> {
  if (!OBJECT_ID.test(id)) return { ok: false, reason: 'MISSING' };
  const filter: Record<string, unknown> = { _id: id };
  if (guard === 'NO_OVERPAY' && delta < 0) filter.balanceKobo = { $gte: -delta };

  const row = await InvoiceModel.findOneAndUpdate(filter, { $inc: { balanceKobo: delta } }, { new: true, session }).lean<Row>();
  if (!row) {
    const exists = await InvoiceModel.exists({ _id: id }).session(session);
    return { ok: false, reason: exists ? 'GUARD' : 'MISSING' };
  }
  const status = statusFor(row.totalKobo, row.balanceKobo);
  if (status !== row.status) await InvoiceModel.updateOne({ _id: id }, { $set: { status } }, { session });
  return { ok: true, invoice: toRecord({ ...row, status }) };
}

const existsForStructure = async (feeStructureId: string): Promise<boolean> =>
  OBJECT_ID.test(feeStructureId) && (await InvoiceModel.exists({ feeStructureId })) !== null;

const countForStructure = async (feeStructureId: string): Promise<number> =>
  OBJECT_ID.test(feeStructureId) ? InvoiceModel.countDocuments({ feeStructureId }) : 0;

async function outstandingForStudent(studentId: string, termId: string): Promise<number> {
  if (!OBJECT_ID.test(studentId) || !OBJECT_ID.test(termId)) return 0;
  const rows = await InvoiceModel.find({ studentId, termId, balanceKobo: { $gt: 0 }, blocksReports: { $ne: false } }, { balanceKobo: 1 }).lean<Row[]>();
  return rows.reduce((sum, r) => sum + r.balanceKobo, 0);
}

/**
 * What each student still owes across ALL sessions, so an old unpaid debt is not forgotten.
 * Extra charges marked as not blocking reports are left out, the same rule the report gate uses.
 */
async function outstandingForStudents(studentIds: string[]): Promise<Map<string, number>> {
  const ids = [...new Set(studentIds)].filter((id) => OBJECT_ID.test(id)).map((id) => new mongoose.Types.ObjectId(id));
  if (ids.length === 0) return new Map();
  const rows = await InvoiceModel.aggregate<{ _id: Types.ObjectId; owedKobo: number }>([
    { $match: { studentId: { $in: ids }, balanceKobo: { $gt: 0 }, blocksReports: { $ne: false } } },
    { $group: { _id: '$studentId', owedKobo: { $sum: '$balanceKobo' } } },
  ]);
  return new Map(rows.map((r) => [r._id.toString(), r.owedKobo]));
}

export interface DefaulterRow { studentId: string; classArmId: string; outstandingKobo: number; invoices: number; oldestDueDate: string }
export interface DefaulterReport {
  students: number; outstandingKobo: number; byClassArm: { classArmId: string; students: number; outstandingKobo: number }[]; rows: DefaulterRow[];
}

/** Students who owe money, biggest debt first, with totals per class. dueBefore limits it to overdue invoices. */
async function defaulters(
  filter: { termId?: string | undefined; classArmId?: string | undefined; dueBefore?: string | undefined },
  o: { page: number; limit: number },
): Promise<DefaulterReport> {
  const match: Record<string, unknown> = { balanceKobo: { $gt: 0 } };
  if (filter.dueBefore) match.dueDate = { $lt: filter.dueBefore };
  if (filter.termId && OBJECT_ID.test(filter.termId)) match.termId = new mongoose.Types.ObjectId(filter.termId);
  if (filter.classArmId && OBJECT_ID.test(filter.classArmId)) match.classArmId = new mongoose.Types.ObjectId(filter.classArmId);

  const [result] = await InvoiceModel.aggregate<{
    rows: { _id: Types.ObjectId; classArmId: Types.ObjectId; outstandingKobo: number; invoices: number; oldestDueDate: string }[];
    totals: { students: number; outstandingKobo: number }[];
    byArm: { _id: Types.ObjectId; students: number; outstandingKobo: number }[];
  }>([
    { $match: match },
    { $group: { _id: '$studentId', classArmId: { $first: '$classArmId' }, outstandingKobo: { $sum: '$balanceKobo' }, invoices: { $sum: 1 }, oldestDueDate: { $min: '$dueDate' } } },
    {
      $facet: {
        rows: [{ $sort: { outstandingKobo: -1, _id: 1 } }, { $skip: skipOf(o.page, o.limit) }, { $limit: o.limit }],
        totals: [{ $group: { _id: null, students: { $sum: 1 }, outstandingKobo: { $sum: '$outstandingKobo' } } }],
        byArm: [{ $group: { _id: '$classArmId', students: { $sum: 1 }, outstandingKobo: { $sum: '$outstandingKobo' } } }],
      },
    },
  ]);

  return {
    students: result?.totals[0]?.students ?? 0,
    outstandingKobo: result?.totals[0]?.outstandingKobo ?? 0,
    byClassArm: (result?.byArm ?? []).map((a) => ({ classArmId: a._id.toString(), students: a.students, outstandingKobo: a.outstandingKobo })),
    rows: (result?.rows ?? []).map((r) => ({ studentId: r._id.toString(), classArmId: r.classArmId.toString(), outstandingKobo: r.outstandingKobo, invoices: r.invoices, oldestDueDate: r.oldestDueDate })),
  };
}

/** Overdue invoices that have not been reminded since `cutoff`. */
async function dueForReminder(filter: InvoiceFilter, cutoff: Date, limit: number): Promise<InvoiceRecord[]> {
  const query = { ...queryOf(filter), $or: [{ lastReminderAt: null }, { lastReminderAt: { $lt: cutoff } }] };
  const rows = await InvoiceModel.find(query).sort({ dueDate: 1, _id: 1 }).limit(limit).lean<Row[]>();
  return rows.map(toRecord);
}

async function markReminded(ids: string[], at: Date): Promise<void> {
  const valid = ids.filter((id) => OBJECT_ID.test(id));
  if (valid.length > 0) await InvoiceModel.updateMany({ _id: { $in: valid } }, { $set: { lastReminderAt: at } });
}

async function idsForScope(filter: { termId?: string | undefined; sessionId?: string | undefined }, limit: number): Promise<string[]> {
  const query: Record<string, unknown> = {};
  if (filter.termId) query.termId = filter.termId;
  if (filter.sessionId) query.sessionId = filter.sessionId;
  return (await InvoiceModel.find(query, { _id: 1 }).limit(limit).lean<Row[]>()).map((r) => r._id.toString());
}

async function totalsByClassArm(filter: { termId: string }): Promise<{ classArmId: string; invoices: number; invoicedKobo: number; outstandingKobo: number; defaulters: number }[]> {
  if (!OBJECT_ID.test(filter.termId)) return [];
  const rows = await InvoiceModel.aggregate<{ _id: Types.ObjectId; invoices: number; invoicedKobo: number; outstandingKobo: number; defaulters: number }>([
    { $match: { termId: new mongoose.Types.ObjectId(filter.termId) } },
    {
      $group: {
        _id: '$classArmId', invoices: { $sum: 1 }, invoicedKobo: { $sum: '$totalKobo' },
        outstandingKobo: { $sum: { $max: [0, '$balanceKobo'] } }, defaulters: { $sum: { $cond: [{ $gt: ['$balanceKobo', 0] }, 1, 0] } },
      },
    },
  ]);
  return rows.map((r) => ({ classArmId: r._id.toString(), invoices: r.invoices, invoicedKobo: r.invoicedKobo, outstandingKobo: r.outstandingKobo, defaulters: r.defaulters }));
}

export const invoiceRepository = {
  create, findById, findManyByIds, list, adjustBalance, existsForStructure, countForStructure,
   outstandingForStudent, outstandingForStudents, defaulters, dueForReminder, markReminded, idsForScope , totalsByClassArm
};