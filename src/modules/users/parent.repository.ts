import type { ClientSession, Types } from 'mongoose';
import { skipOf } from '../../common/utils/pagination';
import { escapeRegex } from '../../common/utils/search';
import { ParentModel, type ParentDocument } from './parent.model';

type Row = ParentDocument & { _id: Types.ObjectId };
export interface ParentRecord { userId: string; firstName: string; lastName: string; address: string | null }
export interface ParentProfileInput { firstName: string; lastName: string; address?: string }

const OBJECT_ID = /^[a-f0-9]{24}$/;
const SORTS = {
  name: { 'profile.lastName': 1, 'profile.firstName': 1 },
  '-name': { 'profile.lastName': -1, 'profile.firstName': -1 },
  createdAt: { createdAt: 1 },
  '-createdAt': { createdAt: -1 },
} as const;
export type ParentSort = keyof typeof SORTS;

const toRecord = (r: Row): ParentRecord => ({
  userId: r.userId.toString(),
  firstName: r.profile.firstName,
  lastName: r.profile.lastName,
  address: r.profile.address ?? null,
});

async function create(data: { userId: string; profile: ParentProfileInput }, session: ClientSession): Promise<ParentRecord> {
  const [doc] = await ParentModel.create([data], { session });
  if (!doc) throw new Error('Parent record was not created');
  return toRecord(doc.toObject() as Row);
}

async function findByUserId(userId: string): Promise<ParentRecord | null> {
  if (!OBJECT_ID.test(userId)) return null;
  const row = await ParentModel.findOne({ userId, deletedAt: null }).lean<Row>();
  return row ? toRecord(row) : null;
}

async function nameMap(userIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds)].filter((id) => OBJECT_ID.test(id));
  if (ids.length === 0) return new Map();
  const rows = await ParentModel.find({ userId: { $in: ids } }).lean<Row[]>();
  return new Map(rows.map((r) => [r.userId.toString(), `${r.profile.firstName} ${r.profile.lastName}`]));
}

async function list(filter: { q?: string | undefined }, o: { page: number; limit: number; sort: ParentSort }) {
  const query: Record<string, unknown> = { deletedAt: null };
  if (filter.q) {
    const rx = { $regex: escapeRegex(filter.q), $options: 'i' };
    query.$or = [{ 'profile.firstName': rx }, { 'profile.lastName': rx }];
  }
  const [rows, total] = await Promise.all([
    ParentModel.find(query).sort({ ...SORTS[o.sort], _id: 1 }).skip(skipOf(o.page, o.limit)).limit(o.limit).lean<Row[]>(),
    ParentModel.countDocuments(query),
  ]);
  return { items: rows.map(toRecord), total };
}

async function updateProfile(userId: string, patch: Partial<ParentProfileInput>, session?: ClientSession): Promise<ParentRecord | null> {
  const set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) if (value !== undefined) set[`profile.${key}`] = value;
  const row = await ParentModel.findOneAndUpdate(
    { userId, deletedAt: null }, { $set: set }, { new: true, runValidators: true, ...(session ? { session } : {}) },
  ).lean<Row>();
  return row ? toRecord(row) : null;
}

async function softDelete(userId: string, now: Date, session: ClientSession): Promise<boolean> {
  const result = await ParentModel.updateOne({ userId, deletedAt: null }, { $set: { deletedAt: now } }, { session });
  return result.matchedCount > 0;
}

export const parentRepository = { create, findByUserId, nameMap, list, updateProfile, softDelete };