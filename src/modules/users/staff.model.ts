import mongoose, { type Model, type Types } from 'mongoose';

export const STAFF_TYPES = { ADMIN: 'ADMIN', TEACHER: 'TEACHER' } as const;
export type StaffType = (typeof STAFF_TYPES)[keyof typeof STAFF_TYPES];

export const GENDERS = ['MALE', 'FEMALE'] as const;
export type Gender = (typeof GENDERS)[number];

export interface StaffDocument {
  userId: Types.ObjectId;
  staffNo: string;
  type: StaffType;
  profile: {
    firstName: string;
    lastName: string;
    gender?: Gender | null;
    dateOfBirth?: Date | null;
    address?: string | null;
  };
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const profileSchema = new mongoose.Schema(
  {
    firstName: { type: String, required: true, trim: true, maxlength: 60 },
    lastName: { type: String, required: true, trim: true, maxlength: 60 },
    gender: { type: String, enum: GENDERS, default: null },
    dateOfBirth: { type: Date, default: null },
    address: { type: String, trim: true, maxlength: 200, default: null },
  },
  { _id: false },
);

const staffSchema = new mongoose.Schema<StaffDocument>(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    staffNo: { type: String, required: true },
    type: { type: String, enum: Object.values(STAFF_TYPES), required: true },
    profile: { type: profileSchema, required: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

staffSchema.index({ userId: 1 }, { unique: true });
staffSchema.index({ staffNo: 1 }, { unique: true });
staffSchema.index({ type: 1, deletedAt: 1, 'profile.lastName': 1 });

export const StaffModel: Model<StaffDocument> =
  (mongoose.models.Staff as Model<StaffDocument> | undefined) ??
  mongoose.model<StaffDocument>('Staff', staffSchema);