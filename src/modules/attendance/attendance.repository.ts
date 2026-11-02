import mongoose, { type Model, type Types } from 'mongoose';
import { skipOf } from '../../common/utils/pagination';

export const ATTENDANCE_STATUSES = ['PRESENT', 'ABSENT', 'LATE', 'EXCUSED'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];
export const STAFF_ATTENDANCE_STATUSES = ['PRESENT', 'ABSENT', 'LATE', 'ON_LEAVE'] as const;
export type StaffAttendanceStatus = (typeof STAFF_ATTENDANCE_STATUSES)[number];

// Dates are plain YYYY-MM-DD strings: a school day has no time zone.
interface AttendanceDocument { studentId: Types.ObjectId; classArmId: Types.ObjectId; date: string; status: AttendanceStatus; markedBy: Types.ObjectId }
interface NoticeDocument { studentId: Types.ObjectId; parentId: Types.ObjectId; fromDate: string; toDate: string; reason: string; createdAt: Date }
interface StaffAttendanceDocument { staffId: Types.ObjectId; date: string; status: StaffAttendanceStatus; markedBy: Types.ObjectId }
type Row<T> = T & { _id: Types.ObjectId };

const attendanceSchema = new mongoose.Schema<AttendanceDocument>(
  {
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    classArmId: { type: mongoose.Schema.Types.ObjectId, ref: 'ClassArm', required: true },
    date: { type: String, required: true },
    status: { type: String, enum: ATTENDANCE_STATUSES, required: true },
    markedBy: { type: mongoose.Schema.Types.ObjectId, required: true },
  },
  { timestamps: true, versionKey: false },
);
attendanceSchema.index({ studentId: 1, date: 1 }, { unique: true });
attendanceSchema.index({ classArmId: 1, date: 1 });
attendanceSchema.index({ date: 1 });

const noticeSchema = new mongoose.Schema<NoticeDocument>(
  {
    studentId: { type: mongoose.Schema.Types.ObjectId, required: true },
    parentId: { type: mongoose.Schema.Types.ObjectId, required: true },
    fromDate: { type: String, required: true },
    toDate: { type: String, required: true },
    reason: { type: String, required: true, maxlength: 500 },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
noticeSchema.index({ studentId: 1, fromDate: 1, toDate: 1 });
noticeSchema.index({ createdAt: -1 });

const staffSchema = new mongoose.Schema<StaffAttendanceDocument>(
  {
    staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: String, required: true },
    status: { type: String, enum: STAFF_ATTENDANCE_STATUSES, required: true },
    markedBy: { type: mongoose.Schema.Types.ObjectId, required: true },
  },
  { timestamps: true, versionKey: false },
);
staffSchema.index({ staffId: 1, date: 1 }, { unique: true });
staffSchema.index({ date: 1 });

const AttendanceModel: Model<AttendanceDocument> =
  (mongoose.models.Attendance as Model<AttendanceDocument> | undefined) ?? mongoose.model<AttendanceDocument>('Attendance', attendanceSchema);
const NoticeModel: Model<NoticeDocument> =
  (mongoose.models.AbsenceNotice as Model<NoticeDocument> | undefined) ?? mongoose.model<NoticeDocument>('AbsenceNotice', noticeSchema);
const StaffAttendanceModel: Model<StaffAttendanceDocument> =
  (mongoose.models.StaffAttendance as Model<StaffAttendanceDocument> | undefined) ?? mongoose.model<StaffAttendanceDocument>('StaffAttendance', staffSchema);

export interface AttendanceRecord { id: string; studentId: string; classArmId: string; date: string; status: AttendanceStatus; markedBy: string }
export interface NoticeRecord { id: string; studentId: string; parentId: string; fromDate: string; toDate: string; reason: string; createdAt: Date }
export interface StaffAttendanceRecord { id: string; staffId: string; date: string; status: StaffAttendanceStatus; markedBy: string }

const OBJECT_ID = /^[a-f0-9]{24}$/;
const toAttendance = (r: Row<AttendanceDocument>): AttendanceRecord => ({
  id: r._id.toString(), studentId: r.studentId.toString(), classArmId: r.classArmId.toString(), date: r.date, status: r.status, markedBy: r.markedBy.toString(),
});
const toNotice = (r: Row<NoticeDocument>): NoticeRecord => ({
  id: r._id.toString(), studentId: r.studentId.toString(), parentId: r.parentId.toString(), fromDate: r.fromDate, toDate: r.toDate, reason: r.reason, createdAt: r.createdAt,
});
const toStaff = (r: Row<StaffAttendanceDocument>): StaffAttendanceRecord => ({
  id: r._id.toString(), staffId: r.staffId.toString(), date: r.date, status: r.status, markedBy: r.markedBy.toString(),
});

const dateRange = (from?: string, to?: string) => (from || to ? { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } : undefined);

/** Saves one day for several students. Marking again replaces the earlier mark. */
async function upsertAttendance(rows: { studentId: string; classArmId: string; date: string; status: AttendanceStatus }[], markedBy: string): Promise<void> {
  if (rows.length === 0) return;
  await AttendanceModel.bulkWrite(
    rows.map((r) => ({
      updateOne: {
        filter: { studentId: r.studentId, date: r.date },
        update: { $set: { classArmId: r.classArmId, status: r.status, markedBy } },
        upsert: true,
      },
    })),
    { ordered: false },
  );
}

export interface AttendanceFilter {
  classArmIds?: string[] | undefined;
  studentId?: string | undefined;
  date?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  status?: AttendanceStatus | undefined;
}

async function listAttendance(filter: AttendanceFilter, o: { page: number; limit: number }) {
  if (filter.classArmIds && filter.classArmIds.length === 0) return { items: [], total: 0 };
  const query: Record<string, unknown> = {};
  if (filter.classArmIds) query.classArmId = { $in: filter.classArmIds };
  if (filter.studentId) query.studentId = filter.studentId;
  if (filter.status) query.status = filter.status;
  if (filter.date) query.date = filter.date;
  else if (dateRange(filter.from, filter.to)) query.date = dateRange(filter.from, filter.to);

  const [rows, total] = await Promise.all([
    AttendanceModel.find(query).sort({ date: -1, _id: 1 }).skip(skipOf(o.page, o.limit)).limit(o.limit).lean<Row<AttendanceDocument>[]>(),
    AttendanceModel.countDocuments(query),
  ]);
  return { items: rows.map(toAttendance), total };
}

async function summaryFor(studentId: string, from?: string, to?: string): Promise<Record<AttendanceStatus, number>> {
  const match: Record<string, unknown> = { studentId: new mongoose.Types.ObjectId(studentId) };
  const range = dateRange(from, to);
  if (range) match.date = range;
  const grouped = await AttendanceModel.aggregate<{ _id: AttendanceStatus; count: number }>([
    { $match: match },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  const result: Record<AttendanceStatus, number> = { PRESENT: 0, ABSENT: 0, LATE: 0, EXCUSED: 0 };
  for (const g of grouped) result[g._id] = g.count;
  return result;
}

/** An absence notice turns already-recorded absences in its range into excused ones. */
async function markExcused(studentId: string, fromDate: string, toDate: string): Promise<number> {
  const result = await AttendanceModel.updateMany(
    { studentId, date: { $gte: fromDate, $lte: toDate }, status: 'ABSENT' },
    { $set: { status: 'EXCUSED' } },
  );
  return result.modifiedCount;
}

/** Which of these students have an absence notice covering this date. */
async function noticesCovering(studentIds: string[], date: string): Promise<string[]> {
  const ids = studentIds.filter((id) => OBJECT_ID.test(id));
  if (ids.length === 0) return [];
  return (await NoticeModel.distinct('studentId', { studentId: { $in: ids }, fromDate: { $lte: date }, toDate: { $gte: date } })).map(String);
}

async function createNotice(data: { studentId: string; parentId: string; fromDate: string; toDate: string; reason: string }): Promise<NoticeRecord> {
  const doc = await NoticeModel.create(data);
  return toNotice(doc.toObject() as Row<NoticeDocument>);
}

async function listNotices(
  filter: { studentIds?: string[] | undefined; studentId?: string | undefined; from?: string | undefined; to?: string | undefined },
  o: { page: number; limit: number },
) {
  if (filter.studentIds && filter.studentIds.length === 0) return { items: [], total: 0 };
  const query: Record<string, unknown> = {};
  if (filter.studentIds) query.studentId = { $in: filter.studentIds };
  if (filter.studentId) query.studentId = filter.studentId;
  // A notice overlaps the window when it starts before the window ends and ends after it starts.
  if (filter.to) query.fromDate = { $lte: filter.to };
  if (filter.from) query.toDate = { $gte: filter.from };

  const [rows, total] = await Promise.all([
    NoticeModel.find(query).sort({ createdAt: -1, _id: -1 }).skip(skipOf(o.page, o.limit)).limit(o.limit).lean<Row<NoticeDocument>[]>(),
    NoticeModel.countDocuments(query),
  ]);
  return { items: rows.map(toNotice), total };
}

async function upsertStaffAttendance(rows: { staffId: string; date: string; status: StaffAttendanceStatus }[], markedBy: string): Promise<void> {
  if (rows.length === 0) return;
  await StaffAttendanceModel.bulkWrite(
    rows.map((r) => ({
      updateOne: { filter: { staffId: r.staffId, date: r.date }, update: { $set: { status: r.status, markedBy } }, upsert: true },
    })),
    { ordered: false },
  );
}

async function listStaffAttendance(
  filter: { staffId?: string | undefined; date?: string | undefined; from?: string | undefined; to?: string | undefined; status?: StaffAttendanceStatus | undefined },
  o: { page: number; limit: number },
) {
  const query: Record<string, unknown> = {};
  if (filter.staffId) query.staffId = filter.staffId;
  if (filter.status) query.status = filter.status;
  if (filter.date) query.date = filter.date;
  else if (dateRange(filter.from, filter.to)) query.date = dateRange(filter.from, filter.to);

  const [rows, total] = await Promise.all([
    StaffAttendanceModel.find(query).sort({ date: -1, _id: 1 }).skip(skipOf(o.page, o.limit)).limit(o.limit).lean<Row<StaffAttendanceDocument>[]>(),
    StaffAttendanceModel.countDocuments(query),
  ]);
  return { items: rows.map(toStaff), total };
}

async function summaryForMany(studentIds: string[], from?: string, to?: string): Promise<Map<string, Record<AttendanceStatus, number>>> {
  const ids = studentIds.filter((id) => OBJECT_ID.test(id)).map((id) => new mongoose.Types.ObjectId(id));
  const result = new Map<string, Record<AttendanceStatus, number>>();
  if (ids.length === 0) return result;

  const match: Record<string, unknown> = { studentId: { $in: ids } };
  const range = dateRange(from, to);
  if (range) match.date = range;

  const grouped = await AttendanceModel.aggregate<{ _id: { s: Types.ObjectId; st: AttendanceStatus }; count: number }>([
    { $match: match },
    { $group: { _id: { s: '$studentId', st: '$status' }, count: { $sum: 1 } } },
  ]);
  for (const g of grouped) {
    const key = g._id.s.toString();
    const entry = result.get(key) ?? { PRESENT: 0, ABSENT: 0, LATE: 0, EXCUSED: 0 };
    entry[g._id.st] = g.count;
    result.set(key, entry);
  }
  return result;
}

export const attendanceRepository = {
  upsertAttendance, listAttendance, summaryFor, markExcused, noticesCovering,
  createNotice, listNotices, upsertStaffAttendance, listStaffAttendance, summaryForMany
};