import mongoose, { type Model, type Types } from 'mongoose';

export interface ClassDocument {
  name: string;
  /** Position in the school, for ordering and promotion: 1 for the lowest class. */
  level: number;
  subjectIds: Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ClassArmDocument {
  classId: Types.ObjectId;
  name: string;
  /** Set in step 7 (teaching assignments). */
  classTeacherId?: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SubjectDocument {
  name: string;
  code: string;
  createdAt: Date;
  updatedAt: Date;
}

// Case-insensitive uniqueness, so "Maths" and "maths" cannot both exist.
const CI = { locale: 'en', strength: 2 } as const;

const classSchema = new mongoose.Schema<ClassDocument>(
  {
    name: { type: String, required: true, trim: true, maxlength: 40 },
    level: { type: Number, required: true, min: 1, max: 30 },
    subjectIds: {
      type: [mongoose.Schema.Types.ObjectId],
      default: [],
      validate: { validator: (ids: unknown[]) => ids.length <= 60, message: 'Too many subjects' },
    },
  },
  { timestamps: true, versionKey: false },
);
classSchema.index({ name: 1 }, { unique: true, collation: CI });
classSchema.index({ level: 1 }, { unique: true });

const armSchema = new mongoose.Schema<ClassArmDocument>(
  {
    classId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true },
    name: { type: String, required: true, trim: true, maxlength: 20 },
    classTeacherId: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: true, versionKey: false },
);
armSchema.index({ classId: 1, name: 1 }, { unique: true, collation: CI });
armSchema.index({ classTeacherId: 1 });

const subjectSchema = new mongoose.Schema<SubjectDocument>(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 10 },
  },
  { timestamps: true, versionKey: false },
);
subjectSchema.index({ code: 1 }, { unique: true });
subjectSchema.index({ name: 1 }, { unique: true, collation: CI });

export const ClassModel: Model<ClassDocument> =
  (mongoose.models.Class as Model<ClassDocument> | undefined) ??
  mongoose.model<ClassDocument>('Class', classSchema);

export const ClassArmModel: Model<ClassArmDocument> =
  (mongoose.models.ClassArm as Model<ClassArmDocument> | undefined) ??
  mongoose.model<ClassArmDocument>('ClassArm', armSchema);

export const SubjectModel: Model<SubjectDocument> =
  (mongoose.models.Subject as Model<SubjectDocument> | undefined) ??
  mongoose.model<SubjectDocument>('Subject', subjectSchema);