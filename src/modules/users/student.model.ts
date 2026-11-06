import mongoose, { type Model, type Types } from 'mongoose';
import { GENDERS, type Gender } from './staff.model';

export const STUDENT_STATUS = { ACTIVE: 'ACTIVE', GRADUATED: 'GRADUATED', WITHDRAWN: 'WITHDRAWN' } as const;
export type StudentStatus = (typeof STUDENT_STATUS)[keyof typeof STUDENT_STATUS];

export interface StudentDocument {
  userId: Types.ObjectId;
  admissionNo: string;
  admissionSessionId: Types.ObjectId;
  profile: {
    firstName: string;
    middleName?: string | null;
    lastName: string;
    gender?: Gender | null;
    dateOfBirth?: Date | null;
    address?: string | null;
    /** Cloudinary delivery URL. The image itself never touches our database. */
    passportUrl?: string | null;
  };
  status: StudentStatus;
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const profileSchema = new mongoose.Schema(
  {
    firstName: { type: String, required: true, trim: true, maxlength: 60 },
    middleName: { type: String, trim: true, maxlength: 60, default: null },
    lastName: { type: String, required: true, trim: true, maxlength: 60 },
    gender: { type: String, enum: GENDERS, default: null },
    dateOfBirth: { type: Date, default: null },
    address: { type: String, trim: true, maxlength: 200, default: null },
    passportUrl: {
      type: String,
      trim: true,
      maxlength: 500,
      default: null,
      validate: { validator: (v: string | null) => v === null || /^https:\/\/res\.cloudinary\.com\//.test(v), message: 'Must be a Cloudinary https URL' },
    },
  },
  { _id: false },
);

const schema = new mongoose.Schema<StudentDocument>(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    admissionNo: { type: String, required: true },
    admissionSessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', required: true },
    profile: { type: profileSchema, required: true },
    status: { type: String, enum: Object.values(STUDENT_STATUS), default: STUDENT_STATUS.ACTIVE },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);
schema.index({ userId: 1 }, { unique: true });
schema.index({ admissionNo: 1 }, { unique: true });
schema.index({ status: 1, deletedAt: 1, 'profile.lastName': 1 });

export const StudentModel: Model<StudentDocument> =
  (mongoose.models.Student as Model<StudentDocument> | undefined) ??
  mongoose.model<StudentDocument>('Student', schema);