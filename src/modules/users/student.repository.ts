import type { ClientSession, Types } from 'mongoose';
import { skipOf } from '../../common/utils/pagination';
import { escapeRegex } from '../../common/utils/search';
import { nextSequence } from './counter.model';
import type { Gender } from './staff.model';
import type { ProfileInput } from './staff.repository';
import { StudentModel, type StudentDocument, type StudentStatus } from './student.model';

type Row = StudentDocument & { _id: Types.ObjectId };

export interface StudentRecord {
  userId: string;
  admissionNo: string;
  admissionSessionId: string;
  firstName: string;
  lastName: string;
  gender: Gender | null;
  dateOfBirth: Date | null;
  address: string | null;
  status: StudentStatus;
}

const OBJECT_ID = /^[a-f0-9]{24}$/;
const SORTS = {
  name: { 'profile.lastName': 1, 'profile.firstName': 1 },
  '-name': { 'profile.lastName': -1, 'profile.firstName': -1 },
  admissionNo: { admissionNo: 1 },
  createdAt: { createdAt: 1 },
  '-createdAt': { createdAt: -1 },
} as const;
export type StudentSort = keyof typeof SORTS;

/** The one place the registration number format lives. */
export const formatAdmissionNo = (year: number, n: number): string => `${year}/${String(n).padStart(4, '0')}`;

const toRecord = (r: Row): StudentRecord => ({
  userId: r.userId.toString(),
  admissionNo: r.admissionNo,
  admissionSessionId: r.admissionSessionId.toString(),
  firstName: r.profile.firstName,
  lastName: r.profile.lastName,
  gender: r.profile.gender ?? null,
  dateOfBirth: r.profile.dateOfBirth ?? null,
  address: r.profile.address ?? null,
  status: r.status,
});

async function create(
  data: { userId: string; admissionSessionId: string; year: number; profile: ProfileInput },
  session: ClientSession,
): Promise<StudentRecord> {
  const admissionNo = formatAdmissionNo(data.year, await nextSequence(`student:${data.year}`, session));
  const [doc] = await StudentModel.create(
    [{ userId: data.userId, admissionNo, admissionSessionId: data.admissionSessionId, profile: data.profile }],
    { session },
  );
  if (!doc) throw new Error('Student record was not created');
  return toRecord(doc.toObject() as Row);
}

async function findByUserId(userId: string): Promise<StudentRecord | null> {
  if (!OBJECT_ID.test(userId)) return null;
  const row = await StudentModel.findOne({ userId, deletedAt: null }).lean<Row>();
  return row ? toRecord(row) : null;
}

async function findManyByUserIds(userIds: string[]): Promise<StudentRecord[]> {
  const ids = [...new Set(userIds)].filter((id) => OBJECT_ID.test(id));
  if (ids.length === 0) return [];
  const rows = await StudentModel.find({ userId: { $in: ids }, deletedAt: null }).lean<Row[]>();
  return rows.map(toRecord);
}

async function findUserIdByAdmissionNo(admissionNo: string): Promise<string | null> {
  const row = await StudentModel.findOne({ admissionNo, deletedAt: null }, { userId: 1 }).lean<Row>();
  return row ? row.userId.toString() : null;
}

async function nameMap(userIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds)].filter((id) => OBJECT_ID.test(id));
  if (ids.length === 0) return new Map();
  const rows = await StudentModel.find({ userId: { $in: ids } }).lean<Row[]>();
  return new Map(rows.map((r) => [r.userId.toString(), `${r.profile.firstName} ${r.profile.lastName}`]));
}

async function list(
  filter: { q?: string | undefined; status?: StudentStatus | undefined; userIds?: string[] | undefined },
  o: { page: number; limit: number; sort: StudentSort },
): Promise<{ items: StudentRecord[]; total: number }> {
  if (filter.userIds && filter.userIds.length === 0) return { items: [], total: 0 };

  const query: Record<string, unknown> = { deletedAt: null };
  if (filter.status) query.status = filter.status;
  if (filter.userIds) query.userId = { $in: filter.userIds };
  if (filter.q) {
    const rx = { $regex: escapeRegex(filter.q), $options: 'i' };
    query.$or = [{ 'profile.firstName': rx }, { 'profile.lastName': rx }, { admissionNo: rx }];
  }

  const [rows, total] = await Promise.all([
    StudentModel.find(query).sort({ ...SORTS[o.sort], _id: 1 }).skip(skipOf(o.page, o.limit)).limit(o.limit).lean<Row[]>(),
    StudentModel.countDocuments(query),
  ]);
  return { items: rows.map(toRecord), total };
}

async function update(
  userId: string,
  patch: Partial<ProfileInput> & { status?: StudentStatus },
  session?: ClientSession,
): Promise<StudentRecord | null> {
  const set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    set[key === 'status' ? 'status' : `profile.${key}`] = value;
  }
  const row = await StudentModel.findOneAndUpdate(
    { userId, deletedAt: null },
    { $set: set },
    { new: true, runValidators: true, ...(session ? { session } : {}) },
  ).lean<Row>();
  return row ? toRecord(row) : null;
}

async function softDelete(userId: string, now: Date, session: ClientSession): Promise<boolean> {
  const result = await StudentModel.updateOne({ userId, deletedAt: null }, { $set: { deletedAt: now } }, { session });
  return result.matchedCount > 0;
}
async function userIdsByAdmissionNos(nos: string[]): Promise<Map<string, string>> {
  if (nos.length === 0) return new Map();
  const rows = await StudentModel.find({ admissionNo: { $in: nos }, deletedAt: null }, { admissionNo: 1, userId: 1 }).lean<Row[]>();
  return new Map(rows.map((r) => [r.admissionNo, r.userId.toString()]));
}

async function profileMap(userIds: string[]): Promise<Map<string, { name: string; admissionNo: string }>> {
  const ids = [...new Set(userIds)].filter((id) => OBJECT_ID.test(id));
  if (ids.length === 0) return new Map();
  const rows = await StudentModel.find({ userId: { $in: ids } }).lean<Row[]>();
  return new Map(rows.map((r) => [r.userId.toString(), { name: `${r.profile.firstName} ${r.profile.lastName}`, admissionNo: r.admissionNo }]));
}
const countActive = (): Promise<number> => StudentModel.countDocuments({ deletedAt: null, status: 'ACTIVE' });
export const studentRepository = {
  create, findByUserId, findManyByUserIds, findUserIdByAdmissionNo,
   nameMap, list, update, softDelete, profileMap, userIdsByAdmissionNos, countActive
};