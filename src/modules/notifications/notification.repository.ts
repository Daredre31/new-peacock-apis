import mongoose, { type Model, type Types } from 'mongoose';

interface NotificationDocument {
  userId: Types.ObjectId;
  type: string;
  title: string;
  body: string;
  data: Record<string, string> | null;
  readAt: Date | null;
  createdAt: Date;
}
type Row = NotificationDocument & { _id: Types.ObjectId };

const schema = new mongoose.Schema<NotificationDocument>(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, required: true, maxlength: 60 },
    title: { type: String, required: true, maxlength: 150 },
    body: { type: String, required: true, maxlength: 600 },
    data: { type: mongoose.Schema.Types.Mixed, default: null },
    readAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
schema.index({ userId: 1, _id: -1 });
schema.index({ userId: 1, readAt: 1 });
// Old notifications clean themselves up after 180 days.
schema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

interface PreferenceDocument { userId: Types.ObjectId; inApp: boolean; email: boolean }
const preferenceSchema = new mongoose.Schema<PreferenceDocument>(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    inApp: { type: Boolean, default: true },
    email: { type: Boolean, default: true },
  },
  { timestamps: true, versionKey: false },
);
preferenceSchema.index({ userId: 1 }, { unique: true });

const NotificationModel: Model<NotificationDocument> =
  (mongoose.models.Notification as Model<NotificationDocument> | undefined) ??
  mongoose.model<NotificationDocument>('Notification', schema);
const PreferenceModel: Model<PreferenceDocument> =
  (mongoose.models.NotificationPreference as Model<PreferenceDocument> | undefined) ??
  mongoose.model<PreferenceDocument>('NotificationPreference', preferenceSchema);

export interface NotificationRecord {
  id: string; type: string; title: string; body: string;
  data: Record<string, string> | null; read: boolean; createdAt: Date;
}
export interface Preferences { inApp: boolean; email: boolean }

const OBJECT_ID = /^[a-f0-9]{24}$/;
const encodeCursor = (id: string): string => Buffer.from(id).toString('base64url');
export function decodeCursor(cursor: string): string | null {
  const id = Buffer.from(cursor, 'base64url').toString();
  return OBJECT_ID.test(id) ? id : null;
}

const toRecord = (r: Row): NotificationRecord => ({
  id: r._id.toString(), type: r.type, title: r.title, body: r.body, data: r.data ?? null, read: r.readAt != null, createdAt: r.createdAt,
});

async function insertMany(docs: { userId: string; type: string; title: string; body: string; data: Record<string, string> | null }[]): Promise<void> {
  if (docs.length > 0) await NotificationModel.insertMany(docs, { ordered: false });
}

async function list(userId: string, o: { limit: number; cursor: string | null; unreadOnly: boolean }) {
  const query: Record<string, unknown> = { userId };
  if (o.cursor) query._id = { $lt: o.cursor };
  if (o.unreadOnly) query.readAt = null;

  const rows = await NotificationModel.find(query).sort({ _id: -1 }).limit(o.limit + 1).lean<Row[]>();
  const page = rows.slice(0, o.limit);
  const last = page.at(-1);
  return { items: page.map(toRecord), nextCursor: rows.length > o.limit && last ? encodeCursor(last._id.toString()) : null };
}

const unreadCount = (userId: string): Promise<number> => NotificationModel.countDocuments({ userId, readAt: null });

/** ids = null marks everything read. */
async function markRead(userId: string, ids: string[] | null, now: Date): Promise<number> {
  const filter: Record<string, unknown> = { userId, readAt: null };
  if (ids) filter._id = { $in: ids.filter((id) => OBJECT_ID.test(id)) };
  const result = await NotificationModel.updateMany(filter, { $set: { readAt: now } });
  return result.modifiedCount;
}

async function preferencesFor(userIds: string[]): Promise<Map<string, Preferences>> {
  const rows = await PreferenceModel.find({ userId: { $in: userIds } }).lean<(PreferenceDocument & { _id: Types.ObjectId })[]>();
  return new Map(rows.map((r) => [r.userId.toString(), { inApp: r.inApp, email: r.email }]));
}

async function setPreferences(userId: string, prefs: Preferences): Promise<void> {
  await PreferenceModel.updateOne({ userId }, { $set: prefs }, { upsert: true });
}

export const notificationRepository = { insertMany, list, unreadCount, markRead, preferencesFor, setPreferences };