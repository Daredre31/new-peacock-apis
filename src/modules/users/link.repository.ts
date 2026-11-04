import mongoose, { type Model, type Types } from 'mongoose';
import { isDuplicateKeyError } from '../../common/utils/mongoErrors';
import { skipOf } from '../../common/utils/pagination';

export const LINK_STATUS = { PENDING: 'PENDING', ACTIVE: 'ACTIVE', REVOKED: 'REVOKED' } as const;
export type LinkStatus = (typeof LINK_STATUS)[keyof typeof LINK_STATUS];
export const RELATIONSHIPS = ['FATHER', 'MOTHER', 'GUARDIAN', 'OTHER'] as const;
export type Relationship = (typeof RELATIONSHIPS)[number];

interface LinkDocument {
  parentId: Types.ObjectId; // the parent's user id
  studentId: Types.ObjectId; // the student's user id
  relationship: Relationship;
  status: LinkStatus;
  createdAt: Date;
  updatedAt: Date;
}
type Row = LinkDocument & { _id: Types.ObjectId };

const schema = new mongoose.Schema<LinkDocument>(
  {
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    relationship: { type: String, enum: RELATIONSHIPS, required: true },
    status: { type: String, enum: Object.values(LINK_STATUS), required: true },
  },
  { timestamps: true, versionKey: false },
);
schema.index({ parentId: 1, studentId: 1 }, { unique: true });
schema.index({ studentId: 1, status: 1 });
schema.index({ status: 1, createdAt: -1 });

const LinkModel: Model<LinkDocument> =
  (mongoose.models.ParentStudentLink as Model<LinkDocument> | undefined) ??
  mongoose.model<LinkDocument>('ParentStudentLink', schema);

export interface LinkRecord {
  id: string;
  parentId: string;
  studentId: string;
  relationship: Relationship;
  status: LinkStatus;
  createdAt: Date;
}

const OBJECT_ID = /^[a-f0-9]{24}$/;
const toRecord = (r: Row): LinkRecord => ({
  id: r._id.toString(), parentId: r.parentId.toString(), studentId: r.studentId.toString(),
  relationship: r.relationship, status: r.status, createdAt: r.createdAt,
});

async function find(parentId: string, studentId: string): Promise<LinkRecord | null> {
  if (!OBJECT_ID.test(parentId) || !OBJECT_ID.test(studentId)) return null;
  const row = await LinkModel.findOne({ parentId, studentId }).lean<Row>();
  return row ? toRecord(row) : null;
}

async function findById(id: string): Promise<LinkRecord | null> {
  if (!OBJECT_ID.test(id)) return null;
  const row = await LinkModel.findById(id).lean<Row>();
  return row ? toRecord(row) : null;
}

/** Creates the link, or switches an existing one to this status. */
async function upsert(data: { parentId: string; studentId: string; relationship: Relationship; status: LinkStatus }): Promise<LinkRecord> {
  const row = await LinkModel.findOneAndUpdate(
    { parentId: data.parentId, studentId: data.studentId },
    { $set: { relationship: data.relationship, status: data.status } },
    { upsert: true, new: true },
  ).lean<Row>();
  if (!row) throw new Error('Link was not saved');
  return toRecord(row);
}

/** For claims: only creates, and reports a duplicate instead of overwriting. */
async function createPending(data: { parentId: string; studentId: string; relationship: Relationship }): Promise<LinkRecord | null> {
  try {
    const doc = await LinkModel.create({ ...data, status: LINK_STATUS.PENDING });
    return toRecord(doc.toObject() as Row);
  } catch (err) {
    if (isDuplicateKeyError(err)) return null;
    throw err;
  }
}

async function setStatus(id: string, status: LinkStatus): Promise<LinkRecord | null> {
  if (!OBJECT_ID.test(id)) return null;
  const row = await LinkModel.findByIdAndUpdate(id, { $set: { status } }, { new: true }).lean<Row>();
  return row ? toRecord(row) : null;
}

async function list(
  filter: { status?: LinkStatus | undefined; parentId?: string | undefined; studentId?: string | undefined },
  o: { page: number; limit: number },
) {
  const query: Record<string, unknown> = {};
  for (const key of ['status', 'parentId', 'studentId'] as const) if (filter[key] !== undefined) query[key] = filter[key];
  const [rows, total] = await Promise.all([
    LinkModel.find(query).sort({ createdAt: -1, _id: -1 }).skip(skipOf(o.page, o.limit)).limit(o.limit).lean<Row[]>(),
    LinkModel.countDocuments(query),
  ]);
  return { items: rows.map(toRecord), total };
}

async function hasActive(parentId: string, studentId: string): Promise<boolean> {
  if (!OBJECT_ID.test(parentId) || !OBJECT_ID.test(studentId)) return false;
  return (await LinkModel.exists({ parentId, studentId, status: LINK_STATUS.ACTIVE })) !== null;
}

async function activeStudentIdsOf(parentId: string): Promise<string[]> {
  if (!OBJECT_ID.test(parentId)) return [];
  const rows = await LinkModel.find({ parentId, status: LINK_STATUS.ACTIVE }, { studentId: 1 }).lean<Row[]>();
  return rows.map((r) => r.studentId.toString());

}

async function activeParentIdsOf(studentIds: string[]): Promise<string[]> {
  const ids = studentIds.filter((id) => OBJECT_ID.test(id));
  if (ids.length === 0) return [];
  const rows = await LinkModel.find({ studentId: { $in: ids }, status: LINK_STATUS.ACTIVE }, { parentId: 1 }).lean<Row[]>();
  return [...new Set(rows.map((r) => r.parentId.toString()))];
}

async function activeLinksForStudents(studentIds: string[]): Promise<{ studentId: string; parentId: string; relationship: Relationship }[]> {
  const ids = studentIds.filter((id) => OBJECT_ID.test(id));
  if (ids.length === 0) return [];
  const rows = await LinkModel.find({ studentId: { $in: ids }, status: LINK_STATUS.ACTIVE }).lean<Row[]>();
  return rows.map((r) => ({ studentId: r.studentId.toString(), parentId: r.parentId.toString(), relationship: r.relationship }));
}

export const linkRepository = { find, findById, upsert, createPending, setStatus, list, hasActive, activeStudentIdsOf,
  activeParentIdsOf, activeLinksForStudents
 };