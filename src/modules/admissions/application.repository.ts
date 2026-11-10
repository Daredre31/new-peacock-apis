import mongoose, { type Model, type Types } from 'mongoose';
import { skipOf } from '../../common/utils/pagination';
import { nextSequence } from '../users/counter.model';

export const ADMISSION_STATUS = { PENDING_PAYMENT: 'PENDING_PAYMENT', SUBMITTED: 'SUBMITTED', ACCEPTED: 'ACCEPTED', DECLINED: 'DECLINED' } as const;
export type AdmissionStatus = (typeof ADMISSION_STATUS)[keyof typeof ADMISSION_STATUS];
export const FEE_PAYMENT_STATUS = { PENDING: 'PENDING', SUCCESS: 'SUCCESS', FAILED: 'FAILED' } as const;
export type FeePaymentStatus = (typeof FEE_PAYMENT_STATUS)[keyof typeof FEE_PAYMENT_STATUS];
const DEFAULT_FEE_KOBO = 200_000; // 2,000 naira
const PENDING_LIFETIME_MS = 14 * 24 * 3600_000;

export interface FeePayment { reference: string; amountKobo: number; status: FeePaymentStatus; checkoutUrl: string | null; createdAt: Date; paidAt: Date | null; lastVerifyAt?: Date | null }
export interface ApplicationChild {
  firstName: string; middleName: string | null; lastName: string; gender: 'MALE' | 'FEMALE'; dateOfBirth: string; classId: string;
  previousSchool: string | null; address: string | null;
}
export interface ApplicationParent {
  firstName: string; lastName: string; email: string; phone: string; relationship: 'FATHER' | 'MOTHER' | 'GUARDIAN' | 'OTHER'; address: string | null;
}

interface ApplicationDocument {
  applicationNo: string; status: AdmissionStatus; child: ApplicationChild; parent: ApplicationParent;
  feeKobo: number; payments: FeePayment[]; paidAt: Date | null; expiresAt: Date | null;
  photoPublicId: string | null; photoUrl: string | null;
  decidedBy: Types.ObjectId | null; decidedAt: Date | null; declineReason: string | null;
  studentId: Types.ObjectId | null; parentUserId: Types.ObjectId | null; acceptLockAt: Date | null;
  createdAt: Date; updatedAt: Date;
}
type Row = ApplicationDocument & { _id: Types.ObjectId };

const paymentSchema = new mongoose.Schema(
  {
    reference: { type: String, required: true }, amountKobo: { type: Number, required: true },
    status: { type: String, enum: Object.values(FEE_PAYMENT_STATUS), default: FEE_PAYMENT_STATUS.PENDING },
    checkoutUrl: { type: String, default: null }, createdAt: { type: Date, required: true }, paidAt: { type: Date, default: null },
    lastVerifyAt: { type: Date, default: null },
  },
  { _id: false },
);
const schema = new mongoose.Schema<ApplicationDocument>(
  {
    applicationNo: { type: String, required: true, unique: true },
    status: { type: String, enum: Object.values(ADMISSION_STATUS), default: ADMISSION_STATUS.PENDING_PAYMENT },
    child: {
      firstName: { type: String, required: true, maxlength: 60 }, middleName: { type: String, default: null, maxlength: 60 },
      lastName: { type: String, required: true, maxlength: 60 }, gender: { type: String, enum: ['MALE', 'FEMALE'], required: true },
      dateOfBirth: { type: String, required: true }, classId: { type: String, required: true },
      previousSchool: { type: String, default: null, maxlength: 120 }, address: { type: String, default: null, maxlength: 200 },
    },
    parent: {
      firstName: { type: String, required: true, maxlength: 60 }, lastName: { type: String, required: true, maxlength: 60 },
      email: { type: String, required: true, maxlength: 254 }, phone: { type: String, required: true, maxlength: 30 },
      relationship: { type: String, enum: ['FATHER', 'MOTHER', 'GUARDIAN', 'OTHER'], required: true }, address: { type: String, default: null, maxlength: 200 },
    },
    feeKobo: { type: Number, required: true },
    payments: { type: [paymentSchema], default: [] },
    paidAt: { type: Date, default: null },
    // Only set while unpaid. The database removes unpaid applications once it passes.
    expiresAt: { type: Date, default: null },
    photoPublicId: { type: String, default: null }, photoUrl: { type: String, default: null },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, default: null }, decidedAt: { type: Date, default: null }, declineReason: { type: String, default: null, maxlength: 300 },
    studentId: { type: mongoose.Schema.Types.ObjectId, default: null }, parentUserId: { type: mongoose.Schema.Types.ObjectId, default: null },
    acceptLockAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);
schema.index({ status: 1, paidAt: -1, createdAt: -1 });
schema.index({ 'payments.reference': 1 });
schema.index({ 'parent.email': 1, 'child.lastName': 1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const ApplicationModel: Model<ApplicationDocument> =
  (mongoose.models.AdmissionApplication as Model<ApplicationDocument> | undefined) ??
  mongoose.model<ApplicationDocument>('AdmissionApplication', schema);

export interface ApplicationRecord {
  id: string; applicationNo: string; status: AdmissionStatus; child: ApplicationChild; parent: ApplicationParent; feeKobo: number;
  payments: FeePayment[]; paidAt: Date | null; photoPublicId: string | null; photoUrl: string | null; declineReason: string | null;
  decidedAt: Date | null; studentId: string | null; parentUserId: string | null; createdAt: Date;
}
const OBJECT_ID = /^[a-f0-9]{24}$/;
const toRecord = (r: Row): ApplicationRecord => ({
  id: r._id.toString(), applicationNo: r.applicationNo, status: r.status,
  child: { ...r.child, middleName: r.child.middleName ?? null, previousSchool: r.child.previousSchool ?? null, address: r.child.address ?? null },
  parent: { ...r.parent, address: r.parent.address ?? null }, feeKobo: r.feeKobo,
  payments: (r.payments ?? []).map((p) => ({ reference: p.reference, amountKobo: p.amountKobo, status: p.status, checkoutUrl: p.checkoutUrl ?? null, createdAt: p.createdAt, paidAt: p.paidAt ?? null, lastVerifyAt: p.lastVerifyAt ?? null })),
  paidAt: r.paidAt ?? null, photoPublicId: r.photoPublicId ?? null, photoUrl: r.photoUrl ?? null, declineReason: r.declineReason ?? null,
  decidedAt: r.decidedAt ?? null, studentId: r.studentId ? r.studentId.toString() : null, parentUserId: r.parentUserId ? r.parentUserId.toString() : null,
  createdAt: r.createdAt,
});
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface NewApplication { child: ApplicationChild; parent: ApplicationParent; feeKobo: number }

async function create(data: NewApplication, now: Date): Promise<ApplicationRecord> {
  const year = now.getUTCFullYear();
  const seq = await nextSequence(`admission-${year}`);
  const doc = await ApplicationModel.create({
    ...data, applicationNo: `ADM-${year}-${String(seq).padStart(4, '0')}`, expiresAt: new Date(now.getTime() + PENDING_LIFETIME_MS),
  });
  return toRecord(doc.toObject() as Row);
}
async function findById(id: string): Promise<ApplicationRecord | null> {
  if (!OBJECT_ID.test(id)) return null;
  const row = await ApplicationModel.findById(id).lean<Row>();
  return row ? toRecord(row) : null;
}
async function findByNo(applicationNo: string): Promise<ApplicationRecord | null> {
  if (typeof applicationNo !== 'string') return null;
  const row = await ApplicationModel.findOne({ applicationNo }).lean<Row>();
  return row ? toRecord(row) : null;
}
async function findByPaymentReference(reference: string): Promise<ApplicationRecord | null> {
  if (typeof reference !== 'string') return null;
  const row = await ApplicationModel.findOne({ 'payments.reference': reference }).lean<Row>();
  return row ? toRecord(row) : null;
}
/** The same child, applied for by the same parent email, that is still alive (not declined). */
async function findDuplicate(parentEmail: string, firstName: string, lastName: string, dateOfBirth: string): Promise<ApplicationRecord | null> {
  const row = await ApplicationModel.findOne({
    'parent.email': parentEmail, 'child.dateOfBirth': dateOfBirth, status: { $ne: ADMISSION_STATUS.DECLINED },
    'child.firstName': new RegExp(`^${escapeRegex(firstName)}$`, 'i'), 'child.lastName': new RegExp(`^${escapeRegex(lastName)}$`, 'i'),
  }).lean<Row>();
  return row ? toRecord(row) : null;
}

async function list(filter: { status?: AdmissionStatus | undefined; q?: string | undefined }, o: { page: number; limit: number }) {
  const query: Record<string, unknown> = {};
  if (filter.status) query.status = filter.status;
  if (filter.q) {
    const rx = new RegExp(escapeRegex(filter.q), 'i');
    query.$or = [{ applicationNo: rx }, { 'child.firstName': rx }, { 'child.lastName': rx }, { 'parent.email': rx }, { 'parent.phone': rx }];
  }
  const [rows, total] = await Promise.all([
    ApplicationModel.find(query).sort({ paidAt: -1, createdAt: -1, _id: -1 }).skip(skipOf(o.page, o.limit)).limit(o.limit).lean<Row[]>(),
    ApplicationModel.countDocuments(query),
  ]);
  return { items: rows.map(toRecord), total };
}

async function addPayment(id: string, payment: FeePayment): Promise<void> {
  await ApplicationModel.updateOne({ _id: id }, { $push: { payments: payment } });
}
async function setCheckout(reference: string, checkoutUrl: string): Promise<void> {
  await ApplicationModel.updateOne({ 'payments.reference': reference }, { $set: { 'payments.$.checkoutUrl': checkoutUrl } });
}
async function markPaymentFailed(reference: string): Promise<void> {
  await ApplicationModel.updateOne(
    { payments: { $elemMatch: { reference, status: FEE_PAYMENT_STATUS.PENDING } } }, { $set: { 'payments.$.status': FEE_PAYMENT_STATUS.FAILED } },
  );
}
/** Throttles checks with Paystack: true for only one caller per window. */
async function claimVerify(reference: string, minGapMs: number, now: Date): Promise<boolean> {
  const r = await ApplicationModel.updateOne(
    { payments: { $elemMatch: { reference, status: FEE_PAYMENT_STATUS.PENDING, $or: [{ lastVerifyAt: null }, { lastVerifyAt: { $lt: new Date(now.getTime() - minGapMs) } }] } } },
    { $set: { 'payments.$.lastVerifyAt': now } },
  );
  return r.modifiedCount === 1;
}
/**
 * Marks one payment paid, once. Returns 'ALREADY' if it was paid before, 'FIRST' when this payment
 * moved the application to SUBMITTED, and 'EXTRA' when the application was already paid by another payment.
 */
async function confirmPayment(reference: string, paidAt: Date): Promise<'ALREADY' | 'FIRST' | 'EXTRA'> {
  const marked = await ApplicationModel.findOneAndUpdate(
    { payments: { $elemMatch: { reference, status: { $ne: FEE_PAYMENT_STATUS.SUCCESS } } } },
    { $set: { 'payments.$.status': FEE_PAYMENT_STATUS.SUCCESS, 'payments.$.paidAt': paidAt } },
  ).lean<Row>();
  if (!marked) return 'ALREADY';
  const moved = await ApplicationModel.updateOne(
    { _id: marked._id, status: ADMISSION_STATUS.PENDING_PAYMENT }, { $set: { status: ADMISSION_STATUS.SUBMITTED, paidAt }, $unset: { expiresAt: 1 } },
  );
  return moved.modifiedCount === 1 ? 'FIRST' : 'EXTRA';
}
async function setPhoto(id: string, publicId: string, url: string): Promise<boolean> {
  const r = await ApplicationModel.updateOne({ _id: id, status: ADMISSION_STATUS.SUBMITTED }, { $set: { photoPublicId: publicId, photoUrl: url } });
  return r.matchedCount === 1;
}

/** One caller at a time may accept an application. A lock left behind by a crash expires. */
async function claimAccept(id: string, now: Date, staleBefore: Date): Promise<ApplicationRecord | null> {
  if (!OBJECT_ID.test(id)) return null;
  const row = await ApplicationModel.findOneAndUpdate(
    { _id: id, status: ADMISSION_STATUS.SUBMITTED, $or: [{ acceptLockAt: null }, { acceptLockAt: { $lt: staleBefore } }] },
    { $set: { acceptLockAt: now } }, { new: true },
  ).lean<Row>();
  return row ? toRecord(row) : null;
}
async function saveProgress(id: string, progress: { studentId?: string; parentUserId?: string }): Promise<void> {
  await ApplicationModel.updateOne({ _id: id }, { $set: progress });
}
async function releaseAccept(id: string): Promise<void> {
  await ApplicationModel.updateOne({ _id: id }, { $set: { acceptLockAt: null } });
}
async function finishAccept(id: string, by: string, at: Date): Promise<ApplicationRecord | null> {
  const row = await ApplicationModel.findOneAndUpdate(
    { _id: id, status: ADMISSION_STATUS.SUBMITTED }, { $set: { status: ADMISSION_STATUS.ACCEPTED, decidedBy: by, decidedAt: at, acceptLockAt: null } }, { new: true },
  ).lean<Row>();
  return row ? toRecord(row) : null;
}
async function decline(id: string, by: string, reason: string, at: Date): Promise<ApplicationRecord | null> {
  if (!OBJECT_ID.test(id)) return null;
  const row = await ApplicationModel.findOneAndUpdate(
    { _id: id, status: ADMISSION_STATUS.SUBMITTED, acceptLockAt: null },
    { $set: { status: ADMISSION_STATUS.DECLINED, decidedBy: by, decidedAt: at, declineReason: reason } }, { new: true },
  ).lean<Row>();
  return row ? toRecord(row) : null;
}

// ---- the admission settings: open or closed, and the fee
interface SettingsDocument { _id: string; open: boolean; feeKobo: number }
const settingsSchema = new mongoose.Schema<SettingsDocument>(
  { _id: { type: String, required: true }, open: { type: Boolean, default: true }, feeKobo: { type: Number, default: DEFAULT_FEE_KOBO, min: 100 } },
  { versionKey: false },
);
const SettingsModel: Model<SettingsDocument> =
  (mongoose.models.AdmissionSettings as Model<SettingsDocument> | undefined) ?? mongoose.model<SettingsDocument>('AdmissionSettings', settingsSchema);
export interface AdmissionSettings { open: boolean; feeKobo: number }
async function getSettings(): Promise<AdmissionSettings> {
  const doc = await SettingsModel.findOneAndUpdate({ _id: 'admissions' }, { $setOnInsert: { open: true, feeKobo: DEFAULT_FEE_KOBO } }, { upsert: true, new: true }).lean<SettingsDocument>();
  return { open: doc?.open ?? true, feeKobo: doc?.feeKobo ?? DEFAULT_FEE_KOBO };
}
async function updateSettings(patch: Partial<AdmissionSettings>): Promise<AdmissionSettings> {
  await getSettings();
  const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const doc = await SettingsModel.findOneAndUpdate({ _id: 'admissions' }, { $set: set }, { new: true }).lean<SettingsDocument>();
  return { open: doc?.open ?? true, feeKobo: doc?.feeKobo ?? DEFAULT_FEE_KOBO };
}

export const applicationRepository = {
  create, findById, findByNo, findByPaymentReference, findDuplicate, list, addPayment, setCheckout, markPaymentFailed, claimVerify, confirmPayment,
  setPhoto, claimAccept, saveProgress, releaseAccept, finishAccept, decline, getSettings, updateSettings,
};
