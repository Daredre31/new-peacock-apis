import mongoose, { type ClientSession, type Model, type Types } from 'mongoose';

interface SlotDocument {
  classArmId: Types.ObjectId; day: number; period: number; subjectId: Types.ObjectId; teacherId: Types.ObjectId;
}
type Row = SlotDocument & { _id: Types.ObjectId };

const schema = new mongoose.Schema<SlotDocument>(
  {
    classArmId: { type: mongoose.Schema.Types.ObjectId, ref: 'ClassArm', required: true },
    day: { type: Number, required: true, min: 1, max: 6 }, // 1 = Monday ... 6 = Saturday
    period: { type: Number, required: true, min: 1, max: 12 },
    subjectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Subject', required: true },
    teacherId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true, versionKey: false },
);
schema.index({ classArmId: 1, day: 1, period: 1 }, { unique: true });
schema.index({ teacherId: 1, day: 1, period: 1 });

const SlotModel: Model<SlotDocument> =
  (mongoose.models.TimetableSlot as Model<SlotDocument> | undefined) ?? mongoose.model<SlotDocument>('TimetableSlot', schema);

export interface SlotRecord { classArmId: string; day: number; period: number; subjectId: string; teacherId: string }

const OBJECT_ID = /^[a-f0-9]{24}$/;
const SORT = { day: 1, period: 1 } as const;
const toRecord = (r: Row): SlotRecord => ({
  classArmId: r.classArmId.toString(), day: r.day, period: r.period, subjectId: r.subjectId.toString(), teacherId: r.teacherId.toString(),
});

async function forArm(classArmId: string): Promise<SlotRecord[]> {
  if (!OBJECT_ID.test(classArmId)) return [];
  return (await SlotModel.find({ classArmId }).sort(SORT).lean<Row[]>()).map(toRecord);
}
async function forArmDay(classArmId: string, day: number): Promise<SlotRecord[]> {
  if (!OBJECT_ID.test(classArmId)) return [];
  return (await SlotModel.find({ classArmId, day }).sort(SORT).lean<Row[]>()).map(toRecord);
}
async function forTeacher(teacherId: string): Promise<SlotRecord[]> {
  if (!OBJECT_ID.test(teacherId)) return [];
  return (await SlotModel.find({ teacherId }).sort(SORT).lean<Row[]>()).map(toRecord);
}
async function forTeacherDay(teacherId: string, day: number): Promise<SlotRecord[]> {
  if (!OBJECT_ID.test(teacherId)) return [];
  return (await SlotModel.find({ teacherId, day }).sort(SORT).lean<Row[]>()).map(toRecord);
}

/** Lessons in OTHER classes at the same time for the same teachers. */
async function conflictsFor(armId: string, wanted: { teacherId: string; day: number; period: number }[]): Promise<SlotRecord[]> {
  if (wanted.length === 0) return [];
  const rows = await SlotModel.find({
    classArmId: { $ne: armId },
    $or: wanted.map((w) => ({ teacherId: w.teacherId, day: w.day, period: w.period })),
  }).lean<Row[]>();
  return rows.map(toRecord);
}

/** Replaces the whole timetable of one class. Runs inside the caller's transaction. */
async function replace(armId: string, slots: Omit<SlotRecord, 'classArmId'>[], session: ClientSession): Promise<void> {
  await SlotModel.deleteMany({ classArmId: armId }, { session });
  if (slots.length > 0) await SlotModel.insertMany(slots.map((s) => ({ ...s, classArmId: armId })), { session });
}

export const timetableRepository = { forArm, forArmDay, forTeacher, forTeacherDay, conflictsFor, replace };