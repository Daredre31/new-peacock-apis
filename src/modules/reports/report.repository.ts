import mongoose, { type Model, type Types } from 'mongoose';

export const REPORT_TYPES = ['ENROLMENT', 'ATTENDANCE', 'TERM_RESULTS'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];
export const REPORT_FORMATS = ['CSV', 'PDF'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];
export const REPORT_STATUS = { QUEUED: 'QUEUED', PROCESSING: 'PROCESSING', READY: 'READY', FAILED: 'FAILED' } as const;
export type ReportStatus = (typeof REPORT_STATUS)[keyof typeof REPORT_STATUS];
export type ReportParams = Record<string, string>;

const KEEP_MS = 7 * 86_400_000;

interface ReportDocument {
  type: ReportType; format: ReportFormat; params: ReportParams; requestedBy: Types.ObjectId; status: ReportStatus;
  error: string | null; fileName: string | null; contentType: string | null; size: number | null; rowCount: number | null;
  content?: Buffer; startedAt: Date | null; completedAt: Date | null; expiresAt: Date; createdAt: Date;
}
type Row = ReportDocument & { _id: Types.ObjectId };

const schema = new mongoose.Schema<ReportDocument>(
  {
    type: { type: String, enum: REPORT_TYPES, required: true },
    format: { type: String, enum: REPORT_FORMATS, required: true },
    params: { type: mongoose.Schema.Types.Mixed, default: {} },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: Object.values(REPORT_STATUS), default: REPORT_STATUS.QUEUED },
    error: { type: String, default: null }, fileName: { type: String, default: null }, contentType: { type: String, default: null },
    size: { type: Number, default: null }, rowCount: { type: Number, default: null },
    content: { type: Buffer, select: false }, // the file itself, only loaded when downloading
    startedAt: { type: Date, default: null }, completedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false, minimize: false },
);
schema.index({ requestedBy: 1, status: 1 });
schema.index({ status: 1, createdAt: 1 });
// Files clean themselves up after a week.
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const ReportModel: Model<ReportDocument> =
  (mongoose.models.Report as Model<ReportDocument> | undefined) ?? mongoose.model<ReportDocument>('Report', schema);

export interface ReportRecord {
  id: string; type: ReportType; format: ReportFormat; params: ReportParams; requestedBy: string; status: ReportStatus;
  error: string | null; fileName: string | null; size: number | null; rowCount: number | null;
  createdAt: Date; completedAt: Date | null; expiresAt: Date;
}

const OBJECT_ID = /^[a-f0-9]{24}$/;
const toRecord = (r: Row): ReportRecord => ({
  id: r._id.toString(), type: r.type, format: r.format, params: r.params ?? {}, requestedBy: r.requestedBy.toString(), status: r.status,
  error: r.error ?? null, fileName: r.fileName ?? null, size: r.size ?? null, rowCount: r.rowCount ?? null,
  createdAt: r.createdAt, completedAt: r.completedAt ?? null, expiresAt: r.expiresAt,
});

async function create(data: { type: ReportType; format: ReportFormat; params: ReportParams; requestedBy: string }): Promise<ReportRecord> {
  const doc = await ReportModel.create({ ...data, expiresAt: new Date(Date.now() + KEEP_MS) });
  return toRecord(doc.toObject() as Row);
}

async function findById(id: string): Promise<ReportRecord | null> {
  if (!OBJECT_ID.test(id)) return null;
  const row = await ReportModel.findById(id).lean<Row>();
  return row ? toRecord(row) : null;
}

const countInFlight = (userId: string): Promise<number> =>
  ReportModel.countDocuments({ requestedBy: userId, status: { $in: [REPORT_STATUS.QUEUED, REPORT_STATUS.PROCESSING] } });

/** Of two workers picking up the same report, only one gets it. */
async function claim(id: string): Promise<ReportRecord | null> {
  if (!OBJECT_ID.test(id)) return null;
  const row = await ReportModel.findOneAndUpdate(
    { _id: id, status: REPORT_STATUS.QUEUED }, { $set: { status: REPORT_STATUS.PROCESSING, startedAt: new Date() } }, { new: true },
  ).lean<Row>();
  return row ? toRecord(row) : null;
}

async function complete(id: string, file: { fileName: string; contentType: string; content: Buffer; rowCount: number }): Promise<void> {
  await ReportModel.updateOne(
    { _id: id, status: REPORT_STATUS.PROCESSING },
    { $set: { status: REPORT_STATUS.READY, fileName: file.fileName, contentType: file.contentType, content: file.content, size: file.content.length, rowCount: file.rowCount, completedAt: new Date(), expiresAt: new Date(Date.now() + KEEP_MS) } },
  );
}

async function fail(id: string, message: string): Promise<void> {
  await ReportModel.updateOne(
    { _id: id, status: { $in: [REPORT_STATUS.QUEUED, REPORT_STATUS.PROCESSING] } },
    { $set: { status: REPORT_STATUS.FAILED, error: message, completedAt: new Date() } },
  );
}

async function content(id: string): Promise<{ buffer: Buffer; fileName: string; contentType: string } | null> {
  if (!OBJECT_ID.test(id)) return null;
  const doc = await ReportModel.findById(id).select('+content');
  if (!doc || doc.status !== REPORT_STATUS.READY || !doc.content || !doc.fileName || !doc.contentType) return null;
  return { buffer: Buffer.from(doc.content), fileName: doc.fileName, contentType: doc.contentType };
}

/** Reports stuck in QUEUED or PROCESSING for too long (a crashed worker) are marked failed. */
async function expireStale(cutoff: Date): Promise<number> {
  const result = await ReportModel.updateMany(
    { status: { $in: [REPORT_STATUS.QUEUED, REPORT_STATUS.PROCESSING] }, createdAt: { $lt: cutoff } },
    { $set: { status: REPORT_STATUS.FAILED, error: 'The report took too long. Please try again', completedAt: new Date() } },
  );
  return result.modifiedCount;
}

export const reportRepository = { create, findById, countInFlight, claim, complete, fail, content, expireStale };