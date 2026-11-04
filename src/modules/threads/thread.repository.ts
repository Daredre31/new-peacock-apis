import mongoose, { type ClientSession, type Model, type Types } from 'mongoose';
import { skipOf } from '../../common/utils/pagination';
import { ALL_ROLES, type Role } from '../../config/constants';

export const THREAD_CATEGORIES = ['ABSENCE', 'HEALTH', 'ENQUIRY', 'CONCERN'] as const;
export type ThreadCategory = (typeof THREAD_CATEGORIES)[number];
export const THREAD_STATUS = { OPEN: 'OPEN', ANSWERED: 'ANSWERED', CLOSED: 'CLOSED' } as const;
export type ThreadStatus = (typeof THREAD_STATUS)[keyof typeof THREAD_STATUS];
export type ThreadAudience = 'TEACHER' | 'ADMIN';
export const MAX_MESSAGES = 500;

interface ThreadDocument {
  parentId: Types.ObjectId; studentId: Types.ObjectId; teacherId: Types.ObjectId | null; audience: ThreadAudience;
  category: ThreadCategory; subject: string; status: ThreadStatus; lastMessageAt: Date; lastSenderRole: Role; messageCount: number;
  createdAt: Date; updatedAt: Date;
}
interface MessageDocument { threadId: Types.ObjectId; senderId: Types.ObjectId; senderRole: Role; body: string; createdAt: Date }
type Row<T> = T & { _id: Types.ObjectId };

const threadSchema = new mongoose.Schema<ThreadDocument>(
  {
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    teacherId: { type: mongoose.Schema.Types.ObjectId, default: null },
    audience: { type: String, enum: ['TEACHER', 'ADMIN'], required: true },
    category: { type: String, enum: THREAD_CATEGORIES, required: true },
    subject: { type: String, required: true, maxlength: 150 },
    status: { type: String, enum: Object.values(THREAD_STATUS), default: THREAD_STATUS.OPEN },
    lastMessageAt: { type: Date, required: true },
    lastSenderRole: { type: String, enum: ALL_ROLES, required: true },
    messageCount: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false },
);
threadSchema.index({ parentId: 1, updatedAt: -1 });
threadSchema.index({ teacherId: 1, updatedAt: -1 });
threadSchema.index({ audience: 1, status: 1, updatedAt: -1 });
threadSchema.index({ studentId: 1 });

const messageSchema = new mongoose.Schema<MessageDocument>(
  {
    threadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Thread', required: true },
    senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    senderRole: { type: String, enum: ALL_ROLES, required: true },
    body: { type: String, required: true, maxlength: 2000 },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
messageSchema.index({ threadId: 1, _id: -1 });

const ThreadModel: Model<ThreadDocument> =
  (mongoose.models.Thread as Model<ThreadDocument> | undefined) ?? mongoose.model<ThreadDocument>('Thread', threadSchema);
const MessageModel: Model<MessageDocument> =
  (mongoose.models.ThreadMessage as Model<MessageDocument> | undefined) ?? mongoose.model<MessageDocument>('ThreadMessage', messageSchema);

export interface ThreadRecord {
  id: string; parentId: string; studentId: string; teacherId: string | null; audience: ThreadAudience;
  category: ThreadCategory; subject: string; status: ThreadStatus; lastMessageAt: Date; lastSenderRole: Role; messageCount: number; createdAt: Date;
}
export interface MessageRecord { id: string; senderId: string; senderRole: Role; body: string; createdAt: Date }

const OBJECT_ID = /^[a-f0-9]{24}$/;
const toThread = (r: Row<ThreadDocument>): ThreadRecord => ({
  id: r._id.toString(), parentId: r.parentId.toString(), studentId: r.studentId.toString(), teacherId: r.teacherId ? r.teacherId.toString() : null,
  audience: r.audience, category: r.category, subject: r.subject, status: r.status, lastMessageAt: r.lastMessageAt,
  lastSenderRole: r.lastSenderRole, messageCount: r.messageCount, createdAt: r.createdAt,
});
const toMessage = (r: Row<MessageDocument>): MessageRecord => ({ id: r._id.toString(), senderId: r.senderId.toString(), senderRole: r.senderRole, body: r.body, createdAt: r.createdAt });
const encodeCursor = (id: string): string => Buffer.from(id).toString('base64url');

async function create(
  data: { parentId: string; studentId: string; teacherId: string | null; audience: ThreadAudience; category: ThreadCategory; subject: string },
  body: string, sender: { id: string; role: Role }, session: ClientSession,
): Promise<ThreadRecord> {
  const [thread] = await ThreadModel.create(
    [{ ...data, status: THREAD_STATUS.OPEN, lastMessageAt: new Date(), lastSenderRole: sender.role, messageCount: 1 }], { session },
  );
  if (!thread) throw new Error('Thread was not created');
  await MessageModel.create([{ threadId: thread._id, senderId: sender.id, senderRole: sender.role, body }], { session });
  return toThread(thread.toObject() as Row<ThreadDocument>);
}

async function findById(id: string): Promise<ThreadRecord | null> {
  if (!OBJECT_ID.test(id)) return null;
  const row = await ThreadModel.findById(id).lean<Row<ThreadDocument>>();
  return row ? toThread(row) : null;
}

/** Adds a message and moves the thread to its next status. False if the thread is closed or full. */
async function addMessage(threadId: string, sender: { id: string; role: Role }, body: string, nextStatus: ThreadStatus, session: ClientSession): Promise<boolean> {
  const result = await ThreadModel.updateOne(
    { _id: threadId, status: { $ne: THREAD_STATUS.CLOSED }, messageCount: { $lt: MAX_MESSAGES } },
    { $set: { status: nextStatus, lastMessageAt: new Date(), lastSenderRole: sender.role }, $inc: { messageCount: 1 } },
    { session },
  );
  if (result.matchedCount === 0) return false;
  await MessageModel.create([{ threadId, senderId: sender.id, senderRole: sender.role, body }], { session });
  return true;
}

async function transition(id: string, from: ThreadStatus[], to: ThreadStatus): Promise<ThreadRecord | null> {
  const row = await ThreadModel.findOneAndUpdate({ _id: id, status: { $in: from } }, { $set: { status: to } }, { new: true }).lean<Row<ThreadDocument>>();
  return row ? toThread(row) : null;
}

async function messages(threadId: string, o: { limit: number; before: string | null }) {
  const query: Record<string, unknown> = { threadId };
  if (o.before) query._id = { $lt: o.before };
  const rows = await MessageModel.find(query).sort({ _id: -1 }).limit(o.limit + 1).lean<Row<MessageDocument>[]>();
  const page = rows.slice(0, o.limit);
  const oldest = page.at(-1);
  return { items: page.reverse().map(toMessage), nextCursor: rows.length > o.limit && oldest ? encodeCursor(oldest._id.toString()) : null };
}

async function list(
  filter: { parentId?: string | undefined; teacherId?: string | undefined; studentIds?: string[] | undefined; status?: ThreadStatus | undefined; category?: ThreadCategory | undefined; studentId?: string | undefined },
  o: { page: number; limit: number },
) {
  if (filter.studentIds && filter.studentIds.length === 0) return { items: [], total: 0 };
  const query: Record<string, unknown> = {};
  if (filter.parentId) query.parentId = filter.parentId;
  if (filter.teacherId) query.teacherId = filter.teacherId;
  if (filter.status) query.status = filter.status;
  if (filter.category) query.category = filter.category;
  if (filter.studentIds) query.studentId = { $in: filter.studentIds };
  if (filter.studentId) query.studentId = filter.studentId;

  const [rows, total] = await Promise.all([
    ThreadModel.find(query).sort({ lastMessageAt: -1, _id: -1 }).skip(skipOf(o.page, o.limit)).limit(o.limit).lean<Row<ThreadDocument>[]>(),
    ThreadModel.countDocuments(query),
  ]);
  return { items: rows.map(toThread), total };
}

const countOpenForParent = (parentId: string): Promise<number> =>
  ThreadModel.countDocuments({ parentId, status: { $ne: THREAD_STATUS.CLOSED } });

export const threadRepository = { create, findById, addMessage, transition, messages, list, countOpenForParent };