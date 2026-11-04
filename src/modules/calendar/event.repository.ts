import mongoose, { type Model, type Types } from 'mongoose';
import { skipOf } from '../../common/utils/pagination';
import { ROLES } from '../../config/constants';
import type { Audience, Viewer } from '../announcements/announcement.repository';

interface EventDocument {
  title: string; description: string | null; startsAt: Date; endsAt: Date;
  audience: { type: Audience['type']; roles: string[]; classArmIds: Types.ObjectId[] };
  createdBy: Types.ObjectId; createdAt: Date; updatedAt: Date;
}
type Row = EventDocument & { _id: Types.ObjectId };

const audienceSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['ALL', 'ROLES', 'CLASS_ARMS'], required: true },
    roles: { type: [String], default: [] },
    classArmIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  },
  { _id: false },
);
const schema = new mongoose.Schema<EventDocument>(
  {
    title: { type: String, required: true, maxlength: 150 },
    description: { type: String, default: null, maxlength: 1000 },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    audience: { type: audienceSchema, required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true, versionKey: false },
);
schema.index({ startsAt: 1, endsAt: 1 });
schema.index({ 'audience.classArmIds': 1 });

const EventModel: Model<EventDocument> =
  (mongoose.models.Event as Model<EventDocument> | undefined) ?? mongoose.model<EventDocument>('Event', schema);

export interface EventRecord {
  id: string; title: string; description: string | null; startsAt: Date; endsAt: Date; audience: Audience; createdBy: string; createdAt: Date;
}
export interface EventFields { title: string; description: string | null; startsAt: Date; endsAt: Date; audience: Audience }

const OBJECT_ID = /^[a-f0-9]{24}$/;

function toRecord(r: Row): EventRecord {
  const audience: Audience =
    r.audience.type === 'ROLES' ? { type: 'ROLES', roles: r.audience.roles as Extract<Audience, { type: 'ROLES' }>['roles'] }
    : r.audience.type === 'CLASS_ARMS' ? { type: 'CLASS_ARMS', classArmIds: r.audience.classArmIds.map(String) }
    : { type: 'ALL' };
  return { id: r._id.toString(), title: r.title, description: r.description ?? null, startsAt: r.startsAt, endsAt: r.endsAt, audience, createdBy: r.createdBy.toString(), createdAt: r.createdAt };
}

const toDoc = (a: Audience) => ({
  type: a.type,
  roles: a.type === 'ROLES' ? a.roles : [],
  classArmIds: a.type === 'CLASS_ARMS' ? a.classArmIds : [],
});

/** Staff see every event. Others see events addressed to everyone, to their role, or to their classes. */
function visibleQuery(viewer: Viewer): Record<string, unknown> {
  if (viewer.role === ROLES.SUPER_ADMIN || viewer.role === ROLES.ADMIN) return {};
  return {
    $or: [
      { 'audience.type': 'ALL' },
      { 'audience.type': 'ROLES', 'audience.roles': viewer.role },
      ...(viewer.armIds.length > 0 ? [{ 'audience.type': 'CLASS_ARMS', 'audience.classArmIds': { $in: viewer.armIds } }] : []),
    ],
  };
}

async function create(data: EventFields & { createdBy: string }): Promise<EventRecord> {
  const doc = await EventModel.create({ ...data, audience: toDoc(data.audience) });
  return toRecord(doc.toObject() as Row);
}

async function findById(id: string): Promise<EventRecord | null> {
  if (!OBJECT_ID.test(id)) return null;
  const row = await EventModel.findById(id).lean<Row>();
  return row ? toRecord(row) : null;
}

async function update(id: string, patch: Partial<EventFields>): Promise<EventRecord | null> {
  const { audience, ...rest } = patch;
  const row = await EventModel.findByIdAndUpdate(id, { $set: { ...rest, ...(audience ? { audience: toDoc(audience) } : {}) } }, { new: true }).lean<Row>();
  return row ? toRecord(row) : null;
}

async function remove(id: string): Promise<boolean> {
  return (await EventModel.deleteOne({ _id: id })).deletedCount > 0;
}

/** Events that overlap [from, to] and that this viewer may see. */
async function listVisible(viewer: Viewer, range: { from: Date; to: Date }, o: { page: number; limit: number }) {
  const query = { ...visibleQuery(viewer), startsAt: { $lte: range.to }, endsAt: { $gte: range.from } };
  const [rows, total] = await Promise.all([
    EventModel.find(query).sort({ startsAt: 1, _id: 1 }).skip(skipOf(o.page, o.limit)).limit(o.limit).lean<Row[]>(),
    EventModel.countDocuments(query),
  ]);
  return { items: rows.map(toRecord), total };
}

export const eventRepository = { create, findById, update, remove, listVisible };