import mongoose, { type Model, type Types } from 'mongoose';
import { isDuplicateKeyError } from '../../common/utils/mongoErrors';

export const EVENT_STATUS = { RECEIVED: 'RECEIVED', PROCESSING: 'PROCESSING', PROCESSED: 'PROCESSED', IGNORED: 'IGNORED', FAILED: 'FAILED' } as const;
export type EventStatus = (typeof EVENT_STATUS)[keyof typeof EVENT_STATUS];
export const MAX_EVENT_ATTEMPTS = 8;
export type EventFields = Record<string, string | number | null>;

interface EventDocument {
  bodyHash: string; event: string; reference: string | null; fields: EventFields; status: EventStatus; attempts: number;
  lastError: string | null; receivedAt: Date; nextAttemptAt: Date; lockedAt: Date | null; processedAt: Date | null;
}
type Row = EventDocument & { _id: Types.ObjectId };

const schema = new mongoose.Schema<EventDocument>(
  {
    bodyHash: { type: String, required: true },
    event: { type: String, required: true, maxlength: 60 },
    reference: { type: String, default: null },
    fields: { type: mongoose.Schema.Types.Mixed, default: {} }, // a small safe subset. The raw body is never stored.
    status: { type: String, enum: Object.values(EVENT_STATUS), default: EVENT_STATUS.RECEIVED },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: null },
    receivedAt: { type: Date, default: () => new Date() },
    nextAttemptAt: { type: Date, required: true },
    lockedAt: { type: Date, default: null },
    processedAt: { type: Date, default: null },
  },
  { versionKey: false, minimize: false },
);
// Paystack retries a delivery with the identical body, so the body's hash recognises a repeat.
schema.index({ bodyHash: 1 }, { unique: true });
schema.index({ status: 1, nextAttemptAt: 1 });
schema.index({ receivedAt: 1 }, { expireAfterSeconds: 90 * 86_400 });

const EventModel: Model<EventDocument> =
  (mongoose.models.PaystackEvent as Model<EventDocument> | undefined) ?? mongoose.model<EventDocument>('PaystackEvent', schema);

export interface EventRecord { id: string; event: string; reference: string | null; fields: EventFields; status: EventStatus; attempts: number }
const OBJECT_ID = /^[a-f0-9]{24}$/;
const toRecord = (r: Row): EventRecord => ({ id: r._id.toString(), event: r.event, reference: r.reference ?? null, fields: r.fields ?? {}, status: r.status, attempts: r.attempts });

async function store(data: { bodyHash: string; event: string; reference: string | null; fields: EventFields }): Promise<{ id: string; duplicate: boolean }> {
  try {
    const doc = await EventModel.create({ ...data, nextAttemptAt: new Date(Date.now() + 30_000) });
    return { id: doc._id.toString(), duplicate: false };
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      const existing = await EventModel.findOne({ bodyHash: data.bodyHash }, { _id: 1 }).lean<Row>();
      if (existing) return { id: existing._id.toString(), duplicate: true };
    }
    throw err;
  }
}

/** Of two workers picking up the same event, only one gets it. A crashed worker's lock expires. */
async function claim(id: string, now: Date, staleBefore: Date): Promise<EventRecord | null> {
  if (!OBJECT_ID.test(id)) return null;
  const row = await EventModel.findOneAndUpdate(
    { _id: id, $or: [{ status: EVENT_STATUS.RECEIVED }, { status: EVENT_STATUS.PROCESSING, lockedAt: { $lt: staleBefore } }] },
    { $set: { status: EVENT_STATUS.PROCESSING, lockedAt: now }, $inc: { attempts: 1 } }, { new: true },
  ).lean<Row>();
  return row ? toRecord(row) : null;
}

async function finish(id: string, status: 'PROCESSED' | 'IGNORED'): Promise<void> {
  await EventModel.updateOne({ _id: id }, { $set: { status, processedAt: new Date(), lastError: null, lockedAt: null } });
}

/** Puts the event back for another try with a growing delay, or gives up after the maximum. */
async function retryLater(id: string, error: string, now: Date): Promise<{ failed: boolean }> {
  const row = await EventModel.findById(id, { attempts: 1 }).lean<Row>();
  const attempts = row?.attempts ?? MAX_EVENT_ATTEMPTS;
  if (attempts >= MAX_EVENT_ATTEMPTS) {
    await EventModel.updateOne({ _id: id }, { $set: { status: EVENT_STATUS.FAILED, lastError: error, processedAt: now, lockedAt: null } });
    return { failed: true };
  }
  const delay = Math.min(30_000 * 2 ** attempts, 3_600_000);
  await EventModel.updateOne({ _id: id }, { $set: { status: EVENT_STATUS.RECEIVED, lastError: error, lockedAt: null, nextAttemptAt: new Date(now.getTime() + delay) } });
  return { failed: false };
}

async function listDue(now: Date, limit: number): Promise<EventRecord[]> {
  const rows = await EventModel.find({
    $or: [{ status: EVENT_STATUS.RECEIVED, nextAttemptAt: { $lte: now } }, { status: EVENT_STATUS.PROCESSING, lockedAt: { $lt: new Date(now.getTime() - 5 * 60_000) } }],
  }).sort({ receivedAt: 1 }).limit(limit).lean<Row[]>();
  return rows.map(toRecord);
}

export const paystackEventRepository = { store, claim, finish, retryLater, listDue };