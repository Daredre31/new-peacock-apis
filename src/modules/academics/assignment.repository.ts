import mongoose, { type Model, type Types } from 'mongoose';
import { skipOf } from '../../common/utils/pagination';

interface AssignmentDocument {
  teacherId: Types.ObjectId; // the teacher's user id
  subjectId: Types.ObjectId;
  classArmId: Types.ObjectId;
  sessionId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}
type Row = AssignmentDocument & { _id: Types.ObjectId };

const schema = new mongoose.Schema<AssignmentDocument>(
  {
    teacherId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    subjectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Subject', required: true },
    classArmId: { type: mongoose.Schema.Types.ObjectId, ref: 'ClassArm', required: true },
    sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', required: true },
  },
  { timestamps: true, versionKey: false },
);
// One teacher cannot hold the same subject in the same arm twice. Different teachers may share it.
schema.index({ teacherId: 1, subjectId: 1, classArmId: 1, sessionId: 1 }, { unique: true });
schema.index({ teacherId: 1, sessionId: 1 });
schema.index({ classArmId: 1, sessionId: 1 });

const AssignmentModel: Model<AssignmentDocument> =
  (mongoose.models.TeachingAssignment as Model<AssignmentDocument> | undefined) ??
  mongoose.model<AssignmentDocument>('TeachingAssignment', schema);

export interface AssignmentRecord {
  id: string;
  teacherId: string;
  subjectId: string;
  classArmId: string;
  sessionId: string;
  createdAt: Date;
}

const OBJECT_ID = /^[a-f0-9]{24}$/;
const toRecord = (r: Row): AssignmentRecord => ({
  id: r._id.toString(), teacherId: r.teacherId.toString(), subjectId: r.subjectId.toString(),
  classArmId: r.classArmId.toString(), sessionId: r.sessionId.toString(), createdAt: r.createdAt,
});

async function create(data: { teacherId: string; subjectId: string; classArmId: string; sessionId: string }): Promise<AssignmentRecord> {
  const doc = await AssignmentModel.create(data);
  return toRecord(doc.toObject() as Row);
}

async function findById(id: string): Promise<AssignmentRecord | null> {
  if (!OBJECT_ID.test(id)) return null;
  const row = await AssignmentModel.findById(id).lean<Row>();
  return row ? toRecord(row) : null;
}

async function list(
  filter: { teacherId?: string | undefined; classArmId?: string | undefined; subjectId?: string | undefined; sessionId?: string | undefined },
  o: { page: number; limit: number; sort: 'createdAt' | '-createdAt' },
) {
  const query: Record<string, unknown> = {};
  for (const key of ['teacherId', 'classArmId', 'subjectId', 'sessionId'] as const) if (filter[key] !== undefined) query[key] = filter[key];
  const direction = o.sort === 'createdAt' ? 1 : -1;
  const [rows, total] = await Promise.all([
    AssignmentModel.find(query).sort({ createdAt: direction, _id: direction }).skip(skipOf(o.page, o.limit)).limit(o.limit).lean<Row[]>(),
    AssignmentModel.countDocuments(query),
  ]);
  return { items: rows.map(toRecord), total };
}

async function changeTeacher(id: string, teacherId: string): Promise<AssignmentRecord | null> {
  if (!OBJECT_ID.test(id)) return null;
  const row = await AssignmentModel.findByIdAndUpdate(id, { $set: { teacherId } }, { new: true }).lean<Row>();
  return row ? toRecord(row) : null;
}

async function remove(id: string): Promise<AssignmentRecord | null> {
  if (!OBJECT_ID.test(id)) return null;
  const row = await AssignmentModel.findByIdAndDelete(id).lean<Row>();
  return row ? toRecord(row) : null;
}

async function armIdsOfTeacher(teacherId: string, sessionId: string): Promise<string[]> {
  if (!OBJECT_ID.test(teacherId) || !OBJECT_ID.test(sessionId)) return [];
  const ids = await AssignmentModel.distinct('classArmId', { teacherId, sessionId });
  return ids.map(String);
}

async function holds(teacherId: string, subjectId: string, classArmId: string, sessionId: string): Promise<boolean> {
  if (![teacherId, subjectId, classArmId, sessionId].every((id) => OBJECT_ID.test(id))) return false;
  return (await AssignmentModel.exists({ teacherId, subjectId, classArmId, sessionId })) !== null;
}

async function subjectIdsOfArm(classArmId: string, sessionId: string): Promise<string[]> {
  if (!OBJECT_ID.test(classArmId) || !OBJECT_ID.test(sessionId)) return [];
  return (await AssignmentModel.distinct('subjectId', { classArmId, sessionId })).map(String);
}

export const assignmentRepository = { create, findById, list, changeTeacher, remove, armIdsOfTeacher , holds , subjectIdsOfArm};
