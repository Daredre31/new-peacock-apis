import mongoose, { type Model, type Types } from 'mongoose';

export const SUBMISSION_STATUS = { PENDING: 'PENDING', APPROVED: 'APPROVED', REJECTED: 'REJECTED' } as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUS)[keyof typeof SUBMISSION_STATUS];
export const UPLOADER_ROLES = ['STUDENT', 'PARENT'] as const;
export type UploaderRole = (typeof UPLOADER_ROLES)[number];

/** One row per student: the latest photo someone proposed, and what the admin decided about it. */
export interface PassportSubmissionDocument {
  studentId: Types.ObjectId;
  uploadedBy: Types.ObjectId;
  uploaderRole: UploaderRole;
  /** Cloudinary URL of the proposed photo. Null once it was rejected and removed. */
  url: string | null;
  status: SubmissionStatus;
  reason: string | null;
  reviewedBy: Types.ObjectId | null;
  reviewedAt: Date | null;
  submittedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new mongoose.Schema<PassportSubmissionDocument>(
  {
    studentId: { type: mongoose.Schema.Types.ObjectId, required: true },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, required: true },
    uploaderRole: { type: String, enum: UPLOADER_ROLES, required: true },
    url: { type: String, trim: true, maxlength: 500, default: null },
    status: { type: String, enum: Object.values(SUBMISSION_STATUS), default: SUBMISSION_STATUS.PENDING },
    reason: { type: String, trim: true, maxlength: 300, default: null },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    reviewedAt: { type: Date, default: null },
    submittedAt: { type: Date, required: true },
  },
  { timestamps: true, versionKey: false },
);
schema.index({ studentId: 1 }, { unique: true });
schema.index({ status: 1, submittedAt: 1 });

export const PassportSubmissionModel: Model<PassportSubmissionDocument> =
  (mongoose.models.PassportSubmission as Model<PassportSubmissionDocument> | undefined) ??
  mongoose.model<PassportSubmissionDocument>('PassportSubmission', schema);
