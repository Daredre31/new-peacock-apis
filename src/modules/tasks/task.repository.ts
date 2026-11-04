import mongoose, { type Model, type Types } from 'mongoose';
import { isDuplicateKeyError } from '../../common/utils/mongoErrors';
import { skipOf } from '../../common/utils/pagination';

export const SUBMISSION_STATUS = { SUBMITTED: 'SUBMITTED', GRADED: 'GRADED', RETURNED: 'RETURNED' , PENDING:'PENDING', OVERDUE: 'OVERDUE' } as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUS)[keyof typeof SUBMISSION_STATUS];

interface TaskDocument {
  teachingAssignmentId: Types.ObjectId; teacherId: Types.ObjectId; classArmId: Types.ObjectId;
  subjectId: Types.ObjectId; sessionId: Types.ObjectId;
  title: string; instructions: string; dueAt: Date; maxScore: number; countsToCA: boolean;
  createdAt: Date; updatedAt: Date;
}
interface SubmissionDocument {
  taskId: Types.ObjectId; studentId: Types.ObjectId; text: string; submittedAt: Date; late: boolean;
  score: number | null; feedback: string | null; status: SubmissionStatus;
  gradedAt: Date | null; gradedBy: Types.ObjectId | null;
}
type Row<T> = T & { _id: Types.ObjectId };

const oid = (ref: string) => ({ type: mongoose.Schema.Types.ObjectId, ref, required: true });

const taskSchema = new mongoose.Schema<TaskDocument>(
  {
    teachingAssignmentId: oid('TeachingAssignment'), teacherId: oid('User'), classArmId: oid('ClassArm'),
    subjectId: oid('Subject'), sessionId: oid('Session'),
    title: { type: String, required: true, maxlength: 150 },
    instructions: { type: String, required: true, maxlength: 5000 },
    dueAt: { type: Date, required: true },
    maxScore: { type: Number, required: true, min: 1, max: 1000 },
    countsToCA: { type: Boolean, default: false },
  },
  { timestamps: true, versionKey: false },
);
taskSchema.index({ teachingAssignmentId: 1, dueAt: -1 });
taskSchema.index({ classArmId: 1, sessionId: 1, dueAt: -1 });
taskSchema.index({ teacherId: 1, dueAt: -1 });

const submissionSchema = new mongoose.Schema<SubmissionDocument>(
  {
    taskId: oid('Task'), studentId: oid('User'),
    text: { type: String, required: true, maxlength: 10_000 },
    submittedAt: { type: Date, required: true },
    late: { type: Boolean, default: false },
    score: { type: Number, default: null },
    feedback: { type: String, default: null, maxlength: 2000 },
    status: { type: String, enum: Object.values(SUBMISSION_STATUS), required: true },
    gradedAt: { type: Date, default: null },
    gradedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: false, versionKey: false },
);
submissionSchema.index({ taskId: 1, studentId: 1 }, { unique: true });
submissionSchema.index({ studentId: 1, gradedAt: -1 });

const TaskModel: Model<TaskDocument> =
  (mongoose.models.Task as Model<TaskDocument> | undefined) ?? mongoose.model<TaskDocument>('Task', taskSchema);
const SubmissionModel: Model<SubmissionDocument> =
  (mongoose.models.Submission as Model<SubmissionDocument> | undefined) ?? mongoose.model<SubmissionDocument>('Submission', submissionSchema);

export interface TaskRecord {
  id: string; teachingAssignmentId: string; teacherId: string; classArmId: string; subjectId: string; sessionId: string;
  title: string; instructions: string; dueAt: Date; maxScore: number; countsToCA: boolean; createdAt: Date;
}
export interface SubmissionRecord {
  id: string; taskId: string; studentId: string; text: string; submittedAt: Date; late: boolean;
  score: number | null; feedback: string | null; status: SubmissionStatus; gradedAt: Date | null;
}

const OBJECT_ID = /^[a-f0-9]{24}$/;
const toTask = (r: Row<TaskDocument>): TaskRecord => ({
  id: r._id.toString(), teachingAssignmentId: r.teachingAssignmentId.toString(), teacherId: r.teacherId.toString(),
  classArmId: r.classArmId.toString(), subjectId: r.subjectId.toString(), sessionId: r.sessionId.toString(),
  title: r.title, instructions: r.instructions, dueAt: r.dueAt, maxScore: r.maxScore, countsToCA: r.countsToCA, createdAt: r.createdAt,
});
const toSubmission = (r: Row<SubmissionDocument>): SubmissionRecord => ({
  id: r._id.toString(), taskId: r.taskId.toString(), studentId: r.studentId.toString(), text: r.text,
  submittedAt: r.submittedAt, late: r.late, score: r.score ?? null, feedback: r.feedback ?? null,
  status: r.status, gradedAt: r.gradedAt ?? null,
});

type TaskFields = Omit<TaskRecord, 'id' | 'createdAt'>;

async function createTask(data: TaskFields): Promise<TaskRecord> {
  const doc = await TaskModel.create(data);
  return toTask(doc.toObject() as Row<TaskDocument>);
}

async function findTask(id: string): Promise<TaskRecord | null> {
  if (!OBJECT_ID.test(id)) return null;
  const row = await TaskModel.findById(id).lean<Row<TaskDocument>>();
  return row ? toTask(row) : null;
}

async function updateTask(id: string, patch: Partial<Pick<TaskFields, 'title' | 'instructions' | 'dueAt' | 'maxScore' | 'countsToCA'>>): Promise<TaskRecord | null> {
  const row = await TaskModel.findByIdAndUpdate(id, { $set: patch }, { new: true, runValidators: true }).lean<Row<TaskDocument>>();
  return row ? toTask(row) : null;
}

async function deleteTask(id: string): Promise<boolean> {
  return (await TaskModel.deleteOne({ _id: id })).deletedCount > 0;
}

async function listTasks(
  filter: { teacherId?: string | undefined; teachingAssignmentId?: string | undefined; classArmId?: string | undefined; subjectId?: string | undefined; sessionId?: string | undefined; from?: Date | undefined; to?: Date | undefined },
  o: { page: number; limit: number },
) {
  const query: Record<string, unknown> = {};
  for (const key of ['teacherId', 'teachingAssignmentId', 'classArmId', 'subjectId', 'sessionId'] as const) {
    if (filter[key] !== undefined) query[key] = filter[key];
  }
  if (filter.from || filter.to) query.dueAt = { ...(filter.from ? { $gte: filter.from } : {}), ...(filter.to ? { $lte: filter.to } : {}) };

  const [rows, total] = await Promise.all([
    TaskModel.find(query).sort({ dueAt: -1, _id: -1 }).skip(skipOf(o.page, o.limit)).limit(o.limit).lean<Row<TaskDocument>[]>(),
    TaskModel.countDocuments(query),
  ]);
  return { items: rows.map(toTask), total };
}

/** Every task of a class this session, newest due date first. Capped, which is far more than a term holds. */
async function allTasksForArm(classArmId: string, sessionId: string): Promise<TaskRecord[]> {
  const rows = await TaskModel.find({ classArmId, sessionId }).sort({ dueAt: -1 }).limit(500).lean<Row<TaskDocument>[]>();
  return rows.map(toTask);
}

async function hasSubmissions(taskId: string): Promise<boolean> {
  return (await SubmissionModel.exists({ taskId })) !== null;
}

async function highestScore(taskId: string): Promise<number> {
  const top = await SubmissionModel.findOne({ taskId, score: { $ne: null } }).sort({ score: -1 }).lean<Row<SubmissionDocument>>();
  return top?.score ?? 0;
}

/** Saves a submission. A graded one is final, so it returns null instead of overwriting it. */
async function upsertSubmission(taskId: string, studentId: string, text: string, late: boolean, now: Date): Promise<SubmissionRecord | null> {
  try {
    const row = await SubmissionModel.findOneAndUpdate(
      { taskId, studentId, status: { $ne: SUBMISSION_STATUS.GRADED } },
      { $set: { text, late, submittedAt: now, status: SUBMISSION_STATUS.SUBMITTED, score: null, gradedAt: null, gradedBy: null } },
      { upsert: true, new: true },
    ).lean<Row<SubmissionDocument>>();
    return row ? toSubmission(row) : null;
  } catch (err) {
    if (isDuplicateKeyError(err)) return null; // the existing one is graded, so the filter did not match
    throw err;
  }
}

async function findSubmission(id: string): Promise<SubmissionRecord | null> {
  if (!OBJECT_ID.test(id)) return null;
  const row = await SubmissionModel.findById(id).lean<Row<SubmissionDocument>>();
  return row ? toSubmission(row) : null;
}

async function submissionsOfTask(taskId: string): Promise<SubmissionRecord[]> {
  const rows = await SubmissionModel.find({ taskId }).lean<Row<SubmissionDocument>[]>();
  return rows.map(toSubmission);
}

async function submissionsOfStudent(studentId: string, taskIds: string[]): Promise<Map<string, SubmissionRecord>> {
  const ids = taskIds.filter((id) => OBJECT_ID.test(id));
  if (ids.length === 0) return new Map();
  const rows = await SubmissionModel.find({ studentId, taskId: { $in: ids } }).lean<Row<SubmissionDocument>[]>();
  return new Map(rows.map((r) => [r.taskId.toString(), toSubmission(r)]));
}

/** Only moves a submission that is still in one of the expected statuses, so two actions cannot clash. */
async function applyGrade(
  id: string,
  from: SubmissionStatus[],
  patch: { status: SubmissionStatus; score: number | null; feedback: string | null },
  gradedBy: string,
  now: Date,
): Promise<SubmissionRecord | null> {
  const row = await SubmissionModel.findOneAndUpdate(
    { _id: id, status: { $in: from } },
    { $set: { ...patch, gradedAt: now, gradedBy } },
    { new: true },
  ).lean<Row<SubmissionDocument>>();
  return row ? toSubmission(row) : null;
}

/** For each student: the average percentage over graded tasks marked "counts to CA" in this subject and class. */
async function caAverages(classArmId: string, subjectId: string, sessionId: string) {
  const found = await TaskModel.find({ classArmId, subjectId, sessionId, countsToCA: true }, { maxScore: 1 }).lean<Row<TaskDocument>[]>();
  const byStudent = new Map<string, { average: number; graded: number }>();
  if (found.length === 0) return { taskCount: 0, byStudent };

  const max = new Map(found.map((t) => [t._id.toString(), t.maxScore]));
  const subs = await SubmissionModel.find({
    taskId: { $in: found.map((t) => t._id) }, status: SUBMISSION_STATUS.GRADED, score: { $ne: null },
  }).lean<Row<SubmissionDocument>[]>();

  const acc = new Map<string, { sum: number; n: number }>();
  for (const s of subs) {
    const m = max.get(s.taskId.toString());
    if (!m || s.score === null) continue;
    const key = s.studentId.toString();
    const cur = acc.get(key) ?? { sum: 0, n: 0 };
    cur.sum += (s.score / m) * 100;
    cur.n += 1;
    acc.set(key, cur);
  }
  for (const [key, v] of acc) byStudent.set(key, { average: Math.round((v.sum / v.n) * 10) / 10, graded: v.n });
  return { taskCount: found.length, byStudent };
}
/** Per task: how many submissions exist, how many wait for marking, how many are graded. */
async function countsByTask(taskIds: string[]): Promise<Map<string, { submitted: number; awaiting: number; graded: number }>> {
  const ids = taskIds.filter((id) => OBJECT_ID.test(id)).map((id) => new mongoose.Types.ObjectId(id));
  const result = new Map<string, { submitted: number; awaiting: number; graded: number }>();
  if (ids.length === 0) return result;

  const rows = await SubmissionModel.aggregate<{ _id: { t: Types.ObjectId; s: SubmissionStatus }; count: number }>([
    { $match: { taskId: { $in: ids } } },
    { $group: { _id: { t: '$taskId', s: '$status' }, count: { $sum: 1 } } },
  ]);
  for (const r of rows) {
    const key = r._id.t.toString();
    const entry = result.get(key) ?? { submitted: 0, awaiting: 0, graded: 0 };
    entry.submitted += r.count;
    if (r._id.s === SUBMISSION_STATUS.SUBMITTED) entry.awaiting += r.count;
    if (r._id.s === SUBMISSION_STATUS.GRADED) entry.graded += r.count;
    result.set(key, entry);
  }
  return result;
}

/** Students averaging below a percentage on this teacher's graded tasks (at least `minGraded` of them). */
async function lowPerformers(teacherId: string, sessionId: string, below: number, limit: number, minGraded = 2): Promise<{ studentId: string; average: number; graded: number }[]> {
  if (!OBJECT_ID.test(teacherId) || !OBJECT_ID.test(sessionId)) return [];
  const found = await TaskModel.find({ teacherId, sessionId }, { maxScore: 1 }).limit(500).lean<Row<TaskDocument>[]>();
  if (found.length === 0) return [];

  const max = new Map(found.map((t) => [t._id.toString(), t.maxScore]));
  const subs = await SubmissionModel.find(
    { taskId: { $in: found.map((t) => t._id) }, status: SUBMISSION_STATUS.GRADED, score: { $ne: null } },
    { studentId: 1, taskId: 1, score: 1 },
  ).limit(20_000).lean<Row<SubmissionDocument>[]>();

  const acc = new Map<string, { sum: number; n: number }>();
  for (const s of subs) {
    const m = max.get(s.taskId.toString());
    if (!m || s.score === null) continue;
    const key = s.studentId.toString();
    const cur = acc.get(key) ?? { sum: 0, n: 0 };
    cur.sum += (s.score / m) * 100;
    cur.n += 1;
    acc.set(key, cur);
  }
  return [...acc]
    .map(([studentId, v]) => ({ studentId, graded: v.n, average: Math.round((v.sum / v.n) * 10) / 10 }))
    .filter((r) => r.graded >= minGraded && r.average < below)
    .sort((a, b) => a.average - b.average)
    .slice(0, limit);
}

export const taskRepository = {
  createTask, findTask, updateTask, deleteTask, listTasks, allTasksForArm, hasSubmissions, highestScore,
  upsertSubmission, findSubmission, submissionsOfTask, submissionsOfStudent, applyGrade,caAverages, countsByTask, lowPerformers
};