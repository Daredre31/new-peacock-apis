import mongoose, { type Types } from 'mongoose';
import { skipOf } from '../../common/utils/pagination';
import { escapeRegex } from '../../common/utils/search';
import { SessionModel, TermModel, type SessionDocument, type TermDocument } from './session.model';

type SessionRow = SessionDocument & { _id: Types.ObjectId };
type TermRow = TermDocument & { _id: Types.ObjectId };

export interface SessionRecord {
  id: string;
  name: string;
  startDate: Date;
  endDate: Date;
  isCurrent: boolean;
}

export interface TermRecord extends SessionRecord {
  sessionId: string;
  locked: boolean;
}

const SESSION_SORTS = {
  '-startDate': { startDate: -1 },
  startDate: { startDate: 1 },
  name: { name: 1 },
  '-name': { name: -1 },
} as const;
export type SessionSort = keyof typeof SESSION_SORTS;

const TERM_SORTS = { startDate: { startDate: 1 }, '-startDate': { startDate: -1 } } as const;
export type TermSort = keyof typeof TERM_SORTS;

const OBJECT_ID = /^[a-f0-9]{24}$/;

const toSession = (row: SessionRow): SessionRecord => ({
  id: row._id.toString(),
  name: row.name,
  startDate: row.startDate,
  endDate: row.endDate,
  isCurrent: row.isCurrent,
});

const toTerm = (row: TermRow): TermRecord => ({
  id: row._id.toString(),
  sessionId: row.sessionId.toString(),
  name: row.name,
  startDate: row.startDate,
  endDate: row.endDate,
  isCurrent: row.isCurrent,
  locked: row.locked,
});

interface PageOptions<S> {
  page: number;
  limit: number;
  sort: S;
}

async function listSessions(filter: { q?: string; isCurrent?: boolean }, options: PageOptions<SessionSort>) {
  const query: Record<string, unknown> = {};
  if (filter.q) query.name = { $regex: escapeRegex(filter.q), $options: 'i' };
  if (filter.isCurrent !== undefined) query.isCurrent = filter.isCurrent;

  const [rows, total] = await Promise.all([
    SessionModel.find(query)
      .sort({ ...SESSION_SORTS[options.sort], _id: 1 })
      .skip(skipOf(options.page, options.limit))
      .limit(options.limit)
      .lean<SessionRow[]>(),
    SessionModel.countDocuments(query),
  ]);
  return { items: rows.map(toSession), total };
}

async function findSession(id: string): Promise<SessionRecord | null> {
  if (!OBJECT_ID.test(id)) return null;
  const row = await SessionModel.findById(id).lean<SessionRow>();
  return row ? toSession(row) : null;
}

async function createSession(data: { name: string; startDate: Date; endDate: Date }): Promise<SessionRecord> {
  const doc = await SessionModel.create({ ...data, isCurrent: false });
  return toSession(doc.toObject() as SessionRow);
}

async function updateSession(
  id: string,
  patch: Partial<{ name: string; startDate: Date; endDate: Date }>,
): Promise<SessionRecord | null> {
  const row = await SessionModel.findByIdAndUpdate(id, { $set: patch }, { new: true }).lean<SessionRow>();
  return row ? toSession(row) : null;
}

async function sessionOverlaps(start: Date, end: Date, excludeId?: string): Promise<boolean> {
  const found = await SessionModel.exists({
    ...(excludeId && { _id: { $ne: excludeId } }),
    startDate: { $lt: end },
    endDate: { $gt: start },
  });
  return found !== null;
}

async function listTerms(
  filter: { sessionId?: string; isCurrent?: boolean; locked?: boolean },
  options: PageOptions<TermSort>,
) {
  const query: Record<string, unknown> = {};
  for (const key of ['sessionId', 'isCurrent', 'locked'] as const) {
    const value = filter[key];
    if (value !== undefined) query[key] = value;
  }

  const [rows, total] = await Promise.all([
    TermModel.find(query)
      .sort({ ...TERM_SORTS[options.sort], _id: 1 })
      .skip(skipOf(options.page, options.limit))
      .limit(options.limit)
      .lean<TermRow[]>(),
    TermModel.countDocuments(query),
  ]);
  return { items: rows.map(toTerm), total };
}

async function findTerm(id: string): Promise<TermRecord | null> {
  if (!OBJECT_ID.test(id)) return null;
  const row = await TermModel.findById(id).lean<TermRow>();
  return row ? toTerm(row) : null;
}

async function findTermsOfSession(sessionId: string): Promise<TermRecord[]> {
  const rows = await TermModel.find({ sessionId }).lean<TermRow[]>();
  return rows.map(toTerm);
}

async function createTerm(data: {
  sessionId: string;
  name: string;
  startDate: Date;
  endDate: Date;
}): Promise<TermRecord> {
  const doc = await TermModel.create({ ...data, isCurrent: false, locked: false });
  return toTerm(doc.toObject() as TermRow);
}

async function updateTerm(
  id: string,
  patch: Partial<{ name: string; startDate: Date; endDate: Date }>,
): Promise<TermRecord | null> {
  const row = await TermModel.findByIdAndUpdate(id, { $set: patch }, { new: true }).lean<TermRow>();
  return row ? toTerm(row) : null;
}

async function termOverlaps(sessionId: string, start: Date, end: Date, excludeId?: string): Promise<boolean> {
  const found = await TermModel.exists({
    sessionId,
    ...(excludeId && { _id: { $ne: excludeId } }),
    startDate: { $lt: end },
    endDate: { $gt: start },
  });
  return found !== null;
}

async function setTermLocked(id: string, locked: boolean): Promise<TermRecord | null> {
  const row = await TermModel.findByIdAndUpdate(id, { $set: { locked } }, { new: true }).lean<TermRow>();
  return row ? toTerm(row) : null;
}

/** Moves "current" to this term and its session in one transaction, so there is never zero or two. */
async function makeTermCurrent(termId: string, sessionId: string): Promise<void> {
  await mongoose.connection.transaction(async (session) => {
    await TermModel.updateMany({ isCurrent: true }, { $set: { isCurrent: false } }, { session });
    await SessionModel.updateMany({ isCurrent: true }, { $set: { isCurrent: false } }, { session });
    await TermModel.updateOne({ _id: termId }, { $set: { isCurrent: true } }, { session });
    await SessionModel.updateOne({ _id: sessionId }, { $set: { isCurrent: true } }, { session });
  });
}
async function findCurrentSession(): Promise<SessionRecord | null> {
  const row = await SessionModel.findOne({ isCurrent: true }).lean<SessionRow>();
  return row ? toSession(row) : null;
}
export const sessionRepository = {
  listSessions,
  findSession,
  createSession,
  updateSession,
  sessionOverlaps,
  listTerms,
  findTerm,
  findTermsOfSession,
  createTerm,
  updateTerm,
  termOverlaps,
  setTermLocked,
  makeTermCurrent,
  findCurrentSession
};