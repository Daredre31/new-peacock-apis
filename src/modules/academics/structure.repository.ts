import type { Types } from 'mongoose';
import { skipOf } from '../../common/utils/pagination';
import { escapeRegex } from '../../common/utils/search';
import {
  ClassArmModel,
  ClassModel,
  SubjectModel,
  type ClassArmDocument,
  type ClassDocument,
  type SubjectDocument,
} from './structure.model';

type Row<T> = T & { _id: Types.ObjectId };

export interface ClassRecord {
  id: string;
  name: string;
  level: number;
  subjectIds: string[];
}
export interface ArmRecord {
  id: string;
  classId: string;
  name: string;
  classTeacherId: string | null;
}
export interface SubjectRecord {
  id: string;
  name: string;
  code: string;
}

const OBJECT_ID = /^[a-f0-9]{24}$/;

const CLASS_SORTS = { level: { level: 1 }, '-level': { level: -1 }, name: { name: 1 }, '-name': { name: -1 } } as const;
const ARM_SORTS = { name: { name: 1 }, '-name': { name: -1 } } as const;
const SUBJECT_SORTS = { name: { name: 1 }, '-name': { name: -1 }, code: { code: 1 } } as const;
export type ClassSort = keyof typeof CLASS_SORTS;
export type ArmSort = keyof typeof ARM_SORTS;
export type SubjectSort = keyof typeof SUBJECT_SORTS;

interface PageOptions<S> {
  page: number;
  limit: number;
  sort: S;
}

const toClass = (r: Row<ClassDocument>): ClassRecord => ({
  id: r._id.toString(),
  name: r.name,
  level: r.level,
  subjectIds: r.subjectIds.map(String),
});
const toArm = (r: Row<ClassArmDocument>): ArmRecord => ({
  id: r._id.toString(),
  classId: r.classId.toString(),
  name: r.name,
  classTeacherId: r.classTeacherId ? r.classTeacherId.toString() : null,
});
const toSubject = (r: Row<SubjectDocument>): SubjectRecord => ({
  id: r._id.toString(),
  name: r.name,
  code: r.code,
});

const search = (field: string, q: string) => ({ [field]: { $regex: escapeRegex(q), $options: 'i' } });

// ---- classes
async function listClasses(filter: { q?: string }, o: PageOptions<ClassSort>) {
  const query = filter.q ? search('name', filter.q) : {};
  const [rows, total] = await Promise.all([
    ClassModel.find(query).sort({ ...CLASS_SORTS[o.sort], _id: 1 }).skip(skipOf(o.page, o.limit)).limit(o.limit).lean<Row<ClassDocument>[]>(),
    ClassModel.countDocuments(query),
  ]);
  return { items: rows.map(toClass), total };
}

async function findClass(id: string): Promise<ClassRecord | null> {
  if (!OBJECT_ID.test(id)) return null;
  const row = await ClassModel.findById(id).lean<Row<ClassDocument>>();
  return row ? toClass(row) : null;
}

async function classesByIds(ids: string[]): Promise<Map<string, ClassRecord>> {
  const valid = [...new Set(ids)].filter((id) => OBJECT_ID.test(id));
  const rows = valid.length > 0 ? await ClassModel.find({ _id: { $in: valid } }).lean<Row<ClassDocument>[]>() : [];
  return new Map(rows.map((r) => [r._id.toString(), toClass(r)]));
}

async function createClass(data: { name: string; level: number; subjectIds: string[] }): Promise<ClassRecord> {
  const doc = await ClassModel.create(data);
  return toClass(doc.toObject() as Row<ClassDocument>);
}

async function updateClass(
  id: string,
  patch: Partial<{ name: string; level: number; subjectIds: string[] }>,
): Promise<ClassRecord | null> {
  const row = await ClassModel.findByIdAndUpdate(id, { $set: patch }, { new: true, runValidators: true }).lean<Row<ClassDocument>>();
  return row ? toClass(row) : null;
}

// ---- class arms
async function listArms(filter: { classId?: string; q?: string }, o: PageOptions<ArmSort>) {
  const query: Record<string, unknown> = { ...(filter.q && search('name', filter.q)) };
  if (filter.classId) query.classId = filter.classId;

  const [rows, total] = await Promise.all([
    ClassArmModel.find(query).sort({ ...ARM_SORTS[o.sort], _id: 1 }).skip(skipOf(o.page, o.limit)).limit(o.limit).lean<Row<ClassArmDocument>[]>(),
    ClassArmModel.countDocuments(query),
  ]);
  return { items: rows.map(toArm), total };
}

async function findArm(id: string): Promise<ArmRecord | null> {
  if (!OBJECT_ID.test(id)) return null;
  const row = await ClassArmModel.findById(id).lean<Row<ClassArmDocument>>();
  return row ? toArm(row) : null;
}

async function createArm(data: { classId: string; name: string }): Promise<ArmRecord> {
  const doc = await ClassArmModel.create(data);
  return toArm(doc.toObject() as Row<ClassArmDocument>);
}

async function updateArm(id: string, patch: { name: string }): Promise<ArmRecord | null> {
  const row = await ClassArmModel.findByIdAndUpdate(id, { $set: patch }, { new: true, runValidators: true }).lean<Row<ClassArmDocument>>();
  return row ? toArm(row) : null;
}

// ---- subjects
async function listSubjects(filter: { q?: string }, o: PageOptions<SubjectSort>) {
  const query = filter.q ? { $or: [search('name', filter.q), search('code', filter.q)] } : {};
  const [rows, total] = await Promise.all([
    SubjectModel.find(query).sort({ ...SUBJECT_SORTS[o.sort], _id: 1 }).skip(skipOf(o.page, o.limit)).limit(o.limit).lean<Row<SubjectDocument>[]>(),
    SubjectModel.countDocuments(query),
  ]);
  return { items: rows.map(toSubject), total };
}

async function findSubject(id: string): Promise<SubjectRecord | null> {
  if (!OBJECT_ID.test(id)) return null;
  const row = await SubjectModel.findById(id).lean<Row<SubjectDocument>>();
  return row ? toSubject(row) : null;
}

async function countExistingSubjects(ids: string[]): Promise<number> {
  if (ids.some((id) => !OBJECT_ID.test(id))) return 0;
  return SubjectModel.countDocuments({ _id: { $in: ids } });
}

async function createSubject(data: { name: string; code: string }): Promise<SubjectRecord> {
  const doc = await SubjectModel.create(data);
  return toSubject(doc.toObject() as Row<SubjectDocument>);
}

async function updateSubject(id: string, patch: Partial<{ name: string; code: string }>): Promise<SubjectRecord | null> {
  const row = await SubjectModel.findByIdAndUpdate(id, { $set: patch }, { new: true, runValidators: true }).lean<Row<SubjectDocument>>();
  return row ? toSubject(row) : null;
}

export const structureRepository = {
  listClasses, findClass, classesByIds, createClass, updateClass,
  listArms, findArm, createArm, updateArm,
  listSubjects, findSubject, countExistingSubjects, createSubject, updateSubject,
};