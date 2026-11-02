import mongoose, { type Model, type Types } from 'mongoose';
import { skipOf } from '../../common/utils/pagination';
import { escapeRegex } from '../../common/utils/search';
import { ROLES, type Role } from '../../config/constants';

export const ANNOUNCEMENT_STATUS = { PENDING_APPROVAL: 'PENDING_APPROVAL', APPROVED: 'APPROVED' } as const;
export type AnnouncementStatus = (typeof ANNOUNCEMENT_STATUS)[keyof typeof ANNOUNCEMENT_STATUS];

export type Audience =
  | { type: 'ALL' }
  | { type: 'ROLES'; roles: Role[] }
  | { type: 'CLASS_ARMS'; classArmIds: string[] };

interface AnnouncementDocument {
  authorId: Types.ObjectId;
  authorRole: Role;
  title: string;
  body: string;
  audience: { type: Audience['type']; roles: Role[]; classArmIds: Types.ObjectId[] };
  publishAt: Date;
  expiresAt: Date | null;
  pinned: boolean;
  status: AnnouncementStatus;
  approvedBy: Types.ObjectId | null;
  approvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
type Row = AnnouncementDocument & { _id: Types.ObjectId };

const audienceSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['ALL', 'ROLES', 'CLASS_ARMS'], required: true },
    roles: { type: [String], default: [] },
    classArmIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  },
  { _id: false },
);

const schema = new mongoose.Schema<AnnouncementDocument>(
  {
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    authorRole: { type: String, required: true },
    title: { type: String, required: true, maxlength: 150 },
    body: { type: String, required: true, maxlength: 5000 },
    audience: { type: audienceSchema, required: true },
    publishAt: { type: Date, required: true },
    expiresAt: { type: Date, default: null },
    pinned: { type: Boolean, default: false },
    status: { type: String, enum: Object.values(ANNOUNCEMENT_STATUS), required: true },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    approvedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);
schema.index({ status: 1, publishAt: -1 });
schema.index({ authorId: 1, createdAt: -1 });
schema.index({ 'audience.classArmIds': 1 });

interface ReadDocument { userId: Types.ObjectId; announcementId: Types.ObjectId; readAt: Date }
const readSchema = new mongoose.Schema<ReadDocument>(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, required: true },
    announcementId: { type: mongoose.Schema.Types.ObjectId, required: true },
    readAt: { type: Date, required: true },
  },
  { versionKey: false },
);
readSchema.index({ userId: 1, announcementId: 1 }, { unique: true });
readSchema.index({ announcementId: 1 });

const AnnouncementModel: Model<AnnouncementDocument> =
  (mongoose.models.Announcement as Model<AnnouncementDocument> | undefined) ??
  mongoose.model<AnnouncementDocument>('Announcement', schema);
const ReadModel: Model<ReadDocument> =
  (mongoose.models.AnnouncementRead as Model<ReadDocument> | undefined) ??
  mongoose.model<ReadDocument>('AnnouncementRead', readSchema);

export interface AnnouncementRecord {
  id: string; authorId: string; authorRole: Role; title: string; body: string; audience: Audience;
  publishAt: Date; expiresAt: Date | null; pinned: boolean; status: AnnouncementStatus; createdAt: Date;
}
export interface Viewer { role: Role; armIds: string[] }

const OBJECT_ID = /^[a-f0-9]{24}$/;

function toRecord(r: Row): AnnouncementRecord {
  const audience: Audience =
    r.audience.type === 'ROLES' ? { type: 'ROLES', roles: r.audience.roles }
    : r.audience.type === 'CLASS_ARMS' ? { type: 'CLASS_ARMS', classArmIds: r.audience.classArmIds.map(String) }
    : { type: 'ALL' };
  return {
    id: r._id.toString(), authorId: r.authorId.toString(), authorRole: r.authorRole, title: r.title, body: r.body, audience,
    publishAt: r.publishAt, expiresAt: r.expiresAt ?? null, pinned: r.pinned, status: r.status, createdAt: r.createdAt,
  };
}

const toDocAudience = (a: Audience) => ({
  type: a.type,
  roles: a.type === 'ROLES' ? a.roles : [],
  classArmIds: a.type === 'CLASS_ARMS' ? a.classArmIds : [],
});

/** What a reader may see: approved, already published, not expired, and addressed to them. */
function visibleQuery(viewer: Viewer, now: Date): Record<string, unknown> {
  const and: unknown[] = [{ $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] }];
  if (viewer.role !== ROLES.SUPER_ADMIN && viewer.role !== ROLES.ADMIN) {
    and.push({
      $or: [
        { 'audience.type': 'ALL' },
        { 'audience.type': 'ROLES', 'audience.roles': viewer.role },
        ...(viewer.armIds.length > 0 ? [{ 'audience.type': 'CLASS_ARMS', 'audience.classArmIds': { $in: viewer.armIds } }] : []),
      ],
    });
  }
  return { status: ANNOUNCEMENT_STATUS.APPROVED, publishAt: { $lte: now }, $and: and };
}

const FEED_SORT = { pinned: -1, publishAt: -1, _id: -1 } as const;

async function create(data: {
  authorId: string; authorRole: Role; title: string; body: string; audience: Audience; publishAt: Date;
  expiresAt: Date | null; pinned: boolean; status: AnnouncementStatus;
}): Promise<AnnouncementRecord> {
  const doc = await AnnouncementModel.create({ ...data, audience: toDocAudience(data.audience) });
  return toRecord(doc.toObject() as Row);
}

async function findById(id: string): Promise<AnnouncementRecord | null> {
  if (!OBJECT_ID.test(id)) return null;
  const row = await AnnouncementModel.findById(id).lean<Row>();
  return row ? toRecord(row) : null;
}

async function findVisible(id: string, viewer: Viewer, now: Date): Promise<AnnouncementRecord | null> {
  if (!OBJECT_ID.test(id)) return null;
  const row = await AnnouncementModel.findOne({ _id: id, ...visibleQuery(viewer, now) }).lean<Row>();
  return row ? toRecord(row) : null;
}

async function update(
  id: string,
  patch: Partial<{ title: string; body: string; audience: Audience; publishAt: Date; expiresAt: Date | null; pinned: boolean; status: AnnouncementStatus }>,
): Promise<AnnouncementRecord | null> {
  const { audience, ...rest } = patch;
  const row = await AnnouncementModel.findByIdAndUpdate(
    id,
    { $set: { ...rest, ...(audience ? { audience: toDocAudience(audience) } : {}) } },
    { new: true },
  ).lean<Row>();
  return row ? toRecord(row) : null;
}

/** Only a pending announcement can be approved, so two admins cannot both do it. */
async function approve(id: string, adminId: string, now: Date): Promise<AnnouncementRecord | null> {
  const row = await AnnouncementModel.findOneAndUpdate(
    { _id: id, status: ANNOUNCEMENT_STATUS.PENDING_APPROVAL },
    { $set: { status: ANNOUNCEMENT_STATUS.APPROVED, approvedBy: adminId, approvedAt: now } },
    { new: true },
  ).lean<Row>();
  return row ? toRecord(row) : null;
}

async function remove(id: string): Promise<boolean> {
  if (!OBJECT_ID.test(id)) return false;
  const result = await AnnouncementModel.deleteOne({ _id: id });
  await ReadModel.deleteMany({ announcementId: id });
  return result.deletedCount > 0;
}

async function feed(viewer: Viewer, now: Date, o: { page: number; limit: number }) {
  const query = visibleQuery(viewer, now);
  const [rows, total] = await Promise.all([
    AnnouncementModel.find(query).sort(FEED_SORT).skip(skipOf(o.page, o.limit)).limit(o.limit).lean<Row[]>(),
    AnnouncementModel.countDocuments(query),
  ]);
  return { items: rows.map(toRecord), total };
}

async function manage(
  filter: { authorId?: string | undefined; status?: AnnouncementStatus | undefined; q?: string | undefined },
  o: { page: number; limit: number },
) {
  const query: Record<string, unknown> = {};
  if (filter.authorId) query.authorId = filter.authorId;
  if (filter.status) query.status = filter.status;
  if (filter.q) query.title = { $regex: escapeRegex(filter.q), $options: 'i' };

  const [rows, total] = await Promise.all([
    AnnouncementModel.find(query).sort({ createdAt: -1, _id: -1 }).skip(skipOf(o.page, o.limit)).limit(o.limit).lean<Row[]>(),
    AnnouncementModel.countDocuments(query),
  ]);
  return { items: rows.map(toRecord), total };
}

async function readSet(userId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await ReadModel.find({ userId, announcementId: { $in: ids } }).lean<(ReadDocument & { _id: Types.ObjectId })[]>();
  return new Set(rows.map((r) => r.announcementId.toString()));
}

async function markRead(userId: string, announcementId: string, now: Date): Promise<void> {
  await ReadModel.updateOne({ userId, announcementId }, { $setOnInsert: { readAt: now } }, { upsert: true });
}

async function unreadCount(userId: string, viewer: Viewer, now: Date): Promise<number> {
  const readIds = await ReadModel.find({ userId }, { announcementId: 1 }).lean<(ReadDocument & { _id: Types.ObjectId })[]>();
  return AnnouncementModel.countDocuments({
    ...visibleQuery(viewer, now),
    ...(readIds.length > 0 ? { _id: { $nin: readIds.map((r) => r.announcementId) } } : {}),
  });
}

export const announcementRepository = { create, findById, findVisible, update, approve, remove, feed, manage, readSet, markRead, unreadCount };