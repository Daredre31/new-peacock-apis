import type { Types } from 'mongoose';
import { skipOf } from '../../common/utils/pagination';
import {
  PassportSubmissionModel, SUBMISSION_STATUS, type PassportSubmissionDocument, type SubmissionStatus, type UploaderRole,
} from './submission.model';

type Row = PassportSubmissionDocument & { _id: Types.ObjectId };

export interface SubmissionRecord {
  studentId: string;
  uploadedBy: string;
  uploaderRole: UploaderRole;
  url: string | null;
  status: SubmissionStatus;
  reason: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  submittedAt: Date;
}

const toRecord = (r: Row): SubmissionRecord => ({
  studentId: r.studentId.toString(),
  uploadedBy: r.uploadedBy.toString(),
  uploaderRole: r.uploaderRole,
  url: r.url ?? null,
  status: r.status,
  reason: r.reason ?? null,
  reviewedBy: r.reviewedBy ? r.reviewedBy.toString() : null,
  reviewedAt: r.reviewedAt ?? null,
  submittedAt: r.submittedAt,
});

const OBJECT_ID = /^[a-f0-9]{24}$/;

async function find(studentId: string): Promise<SubmissionRecord | null> {
  if (!OBJECT_ID.test(studentId)) return null;
  const row = await PassportSubmissionModel.findOne({ studentId }).lean<Row>();
  return row ? toRecord(row) : null;
}

/** A new photo replaces whatever was there before and goes back to PENDING. */
async function savePending(input: { studentId: string; uploadedBy: string; uploaderRole: UploaderRole; url: string; now: Date }): Promise<SubmissionRecord> {
  const row = await PassportSubmissionModel.findOneAndUpdate(
    { studentId: input.studentId },
    {
      $set: {
        uploadedBy: input.uploadedBy, uploaderRole: input.uploaderRole, url: input.url, status: SUBMISSION_STATUS.PENDING,
        reason: null, reviewedBy: null, reviewedAt: null, submittedAt: input.now,
      },
    },
    { upsert: true, new: true, runValidators: true },
  ).lean<Row>();
  return toRecord(row);
}

/** Moves PENDING to a decision in one atomic step. Returns null if it was not pending, so two admins cannot both decide. */
async function decide(
  studentId: string,
  to: 'APPROVED' | 'REJECTED',
  by: string,
  extra: { reason?: string | null; url?: string | null; now: Date },
): Promise<SubmissionRecord | null> {
  if (!OBJECT_ID.test(studentId)) return null;
  const set: Record<string, unknown> = { status: to, reviewedBy: by, reviewedAt: extra.now, reason: extra.reason ?? null };
  if (extra.url !== undefined) set.url = extra.url;
  const row = await PassportSubmissionModel.findOneAndUpdate(
    { studentId, status: SUBMISSION_STATUS.PENDING }, { $set: set }, { new: true },
  ).lean<Row>();
  return row ? toRecord(row) : null;
}

/** Undo for a decision whose follow-up step failed. */
async function reopen(studentId: string, url: string): Promise<void> {
  await PassportSubmissionModel.updateOne(
    { studentId },
    { $set: { status: SUBMISSION_STATUS.PENDING, reviewedBy: null, reviewedAt: null, reason: null, url } },
  );
}

async function setUrl(studentId: string, url: string): Promise<void> {
  await PassportSubmissionModel.updateOne({ studentId }, { $set: { url } });
}

async function list(status: SubmissionStatus, o: { page: number; limit: number }): Promise<{ items: SubmissionRecord[]; total: number }> {
  const [rows, total] = await Promise.all([
    PassportSubmissionModel.find({ status }).sort({ submittedAt: 1, _id: 1 }).skip(skipOf(o.page, o.limit)).limit(o.limit).lean<Row[]>(),
    PassportSubmissionModel.countDocuments({ status }),
  ]);
  return { items: rows.map(toRecord), total };
}

export const submissionRepository = { find, savePending, decide, reopen, setUrl, list };
