import mongoose, { type ClientSession, type Model, type Types } from 'mongoose';

export type EnrolmentOutcome = 'PROMOTED' | 'REPEATED' | 'GRADUATED';

interface EnrolmentDocument {
  studentId: Types.ObjectId; // the student's user id
  sessionId: Types.ObjectId;
  classArmId: Types.ObjectId;
  status: 'ACTIVE' | 'COMPLETED';
  /** How the year ended for this student. Set when the enrolment is completed. */
  outcome?: EnrolmentOutcome;
  /** On a new enrolment made by promotion: the session it came from, so it can be undone. */
  promotedFromSessionId?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}
type Row = EnrolmentDocument & { _id: Types.ObjectId };

const schema = new mongoose.Schema<EnrolmentDocument>(
  {
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', required: true },
    classArmId: { type: mongoose.Schema.Types.ObjectId, ref: 'ClassArm', required: true },
    status: { type: String, enum: ['ACTIVE', 'COMPLETED'], default: 'ACTIVE' },
    outcome: { type: String, enum: ['PROMOTED', 'REPEATED', 'GRADUATED'] },
    promotedFromSessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Session' },
  },
  { timestamps: true, versionKey: false },
);
// One class per student per session: history is kept, never overwritten.
schema.index({ studentId: 1, sessionId: 1 }, { unique: true });
schema.index({ classArmId: 1, sessionId: 1 });

const EnrolmentModel: Model<EnrolmentDocument> =
  (mongoose.models.Enrolment as Model<EnrolmentDocument> | undefined) ??
  mongoose.model<EnrolmentDocument>('Enrolment', schema);

export interface EnrolmentRecord { studentId: string; sessionId: string; classArmId: string }

const OBJECT_ID = /^[a-f0-9]{24}$/;
const toRecord = (r: Row): EnrolmentRecord => ({
  studentId: r.studentId.toString(),
  sessionId: r.sessionId.toString(),
  classArmId: r.classArmId.toString(),
});

async function upsert(studentId: string, sessionId: string, classArmId: string, session?: ClientSession): Promise<EnrolmentRecord> {
  const row = await EnrolmentModel.findOneAndUpdate(
    { studentId, sessionId },
    { $set: { classArmId } },
    { upsert: true, new: true, ...(session ? { session } : {}) },
  ).lean<Row>();
  if (!row) throw new Error('Enrolment was not saved');
  return toRecord(row);
}

async function forStudents(studentIds: string[], sessionId: string): Promise<Map<string, EnrolmentRecord>> {
  const ids = [...new Set(studentIds)].filter((id) => OBJECT_ID.test(id));
  if (ids.length === 0 || !OBJECT_ID.test(sessionId)) return new Map();
  const rows = await EnrolmentModel.find({ studentId: { $in: ids }, sessionId }).lean<Row[]>();
  return new Map(rows.map((r) => [r.studentId.toString(), toRecord(r)]));
}

async function studentIdsInArms(armIds: string[], sessionId: string): Promise<string[]> {
  const ids = [...new Set(armIds)].filter((id) => OBJECT_ID.test(id));
  if (ids.length === 0 || !OBJECT_ID.test(sessionId)) return [];
  const rows = await EnrolmentModel.find({ classArmId: { $in: ids }, sessionId }, { studentId: 1 }).lean<Row[]>();
  return rows.map((r) => r.studentId.toString());
}
async function listForSession(sessionId: string, armId: string | undefined, limit: number): Promise<EnrolmentRecord[]> {
  if (!OBJECT_ID.test(sessionId) || (armId !== undefined && !OBJECT_ID.test(armId))) return [];
  const rows = await EnrolmentModel.find({ sessionId, ...(armId ? { classArmId: armId } : {}) }).limit(limit).lean<Row[]>();
  return rows.map(toRecord);
}
export type ApplyOutcomeResult = 'APPLIED' | 'SOURCE_CHANGED' | 'ALREADY_ENROLLED';

/**
 * Ends one student's year and, unless they graduate, starts the next. Run it inside a transaction:
 * both writes happen or neither does. The source enrolment is only completed if it is still active in the
 * arm the caller looked at, so a student who was moved or already processed is left alone.
 */
async function applyOutcome(
  input: { studentId: string; fromSessionId: string; fromArmId: string; outcome: EnrolmentOutcome; next?: { sessionId: string; classArmId: string } },
  session: ClientSession,
): Promise<ApplyOutcomeResult> {
  // Look before writing, so "already enrolled" never leaves a half-finished change behind.
  if (input.next) {
    const exists = await EnrolmentModel.exists({ studentId: input.studentId, sessionId: input.next.sessionId }).session(session);
    if (exists) return 'ALREADY_ENROLLED';
  }
  const closed = await EnrolmentModel.updateOne(
    { studentId: input.studentId, sessionId: input.fromSessionId, classArmId: input.fromArmId, status: 'ACTIVE' },
    { $set: { status: 'COMPLETED', outcome: input.outcome } },
    { session },
  );
  if (closed.matchedCount === 0) return 'SOURCE_CHANGED';
  if (input.next) {
    await EnrolmentModel.create(
      [{ studentId: input.studentId, sessionId: input.next.sessionId, classArmId: input.next.classArmId, status: 'ACTIVE', promotedFromSessionId: input.fromSessionId }],
      { session },
    );
  }
  return 'APPLIED';
}

export const enrolmentRepository = { upsert, forStudents, studentIdsInArms, listForSession, applyOutcome };