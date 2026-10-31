import mongoose, { type Model, type Types } from 'mongoose';

export interface ParentDocument {
  userId: Types.ObjectId;
  profile: { firstName: string; lastName: string; address?: string | null };
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const profileSchema = new mongoose.Schema(
  {
    firstName: { type: String, required: true, trim: true, maxlength: 60 },
    lastName: { type: String, required: true, trim: true, maxlength: 60 },
    address: { type: String, trim: true, maxlength: 200, default: null },
  },
  { _id: false },
);

const schema = new mongoose.Schema<ParentDocument>(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    profile: { type: profileSchema, required: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);
schema.index({ userId: 1 }, { unique: true });
schema.index({ deletedAt: 1, 'profile.lastName': 1 });

export const ParentModel: Model<ParentDocument> =
  (mongoose.models.Parent as Model<ParentDocument> | undefined) ??
  mongoose.model<ParentDocument>('Parent', schema);