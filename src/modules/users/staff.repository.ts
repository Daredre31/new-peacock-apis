import type { ClientSession, Types } from 'mongoose';
import { skipOf } from '../../common/utils/pagination';
import { escapeRegex } from '../../common/utils/search';
import { nextSequence } from './counter.model';
import { StaffModel, type Gender, type StaffDocument, type StaffType } from './staff.model';

type Row = StaffDocument & { _id: Types.ObjectId };

export interface StaffRecord {
  userId: string;
  staffNo: string;
  type: StaffType;
  firstName: string;
  lastName: string;
  gender: Gender | null;
  dateOfBirth: Date | null;
  address: string | null;
}

export interface ProfileInput {
  firstName: string;
  lastName: string;
  gender?: Gender;
  dateOfBirth?: Date;
  address?: string;
}

const OBJECT_ID = /^[a-f0-9]{24}$/;
const opts = (session?: ClientSession) => (session ? { session } : {});

const SORTS = {
  name: { 'profile.lastName': 1, 'profile.firstName': 1 },
  '-name': { 'profile.lastName': -1, 'profile.firstName': -1 },
  staffNo: { staffNo: 1 },
  createdAt: { createdAt: 1 },
  '-createdAt': { createdAt: -1 },
} as const;
export type StaffSort = keyof typeof SORTS;

/** The one place the staff number format lives. */
export const formatStaffNo = (n: number): string => `STF-${String(n).padStart(4, '0')}`;

const toRecord = (r: Row): StaffRecord => ({
  userId: r.userId.toString(),
  staffNo: r.staffNo,
  type: r.type,
  firstName: r.profile.firstName,
  lastName: r.profile.lastName,
  gender: r.profile.gender ?? null,
  dateOfBirth: r.profile.dateOfBirth ?? null,
  address: r.profile.address ?? null,
});

async function create(
  data: { userId: string; type: StaffType; profile: ProfileInput },
  session: ClientSession,
): Promise<StaffRecord> {
  const staffNo = formatStaffNo(await nextSequence('staff', session));
  const [doc] = await StaffModel.create([{ ...data, staffNo }], { session });
  if (!doc) throw new Error('Staff record was not created');
  return toRecord(doc.toObject() as Row);
}

async function findByUserId(userId: string): Promise<StaffRecord | null> {
  if (!OBJECT_ID.test(userId)) return null;
  const row = await StaffModel.findOne({ userId, deletedAt: null }).lean<Row>();
  return row ? toRecord(row) : null;
}

async function findUserIdByStaffNo(staffNo: string): Promise<string | null> {
  const row = await StaffModel.findOne({ staffNo, deletedAt: null }, { userId: 1 }).lean<Row>();
  return row ? row.userId.toString() : null;
}

async function list(
  filter: { type: StaffType; q?: string },
  o: { page: number; limit: number; sort: StaffSort },
): Promise<{ items: StaffRecord[]; total: number }> {
  const query: Record<string, unknown> = { type: filter.type, deletedAt: null };
  if (filter.q) {
    const rx = { $regex: escapeRegex(filter.q), $options: 'i' };
    query.$or = [{ 'profile.firstName': rx }, { 'profile.lastName': rx }, { staffNo: rx }];
  }

  const [rows, total] = await Promise.all([
    StaffModel.find(query).sort({ ...SORTS[o.sort], _id: 1 }).skip(skipOf(o.page, o.limit)).limit(o.limit).lean<Row[]>(),
    StaffModel.countDocuments(query),
  ]);
  return { items: rows.map(toRecord), total };
}

async function updateProfile(
  userId: string,
  patch: Partial<ProfileInput>,
  session?: ClientSession,
): Promise<StaffRecord | null> {
  const set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) set[`profile.${key}`] = value;
  }
  const row = await StaffModel.findOneAndUpdate(
    { userId, deletedAt: null },
    { $set: set },
    { new: true, runValidators: true, ...opts(session) },
  ).lean<Row>();
  return row ? toRecord(row) : null;
}

async function softDelete(userId: string, now: Date, session: ClientSession): Promise<boolean> {
  const result = await StaffModel.updateOne({ userId, deletedAt: null }, { $set: { deletedAt: now } }, { session });
  return result.matchedCount > 0;
}

export const staffRepository = { create, findByUserId, findUserIdByStaffNo, list, updateProfile, softDelete };