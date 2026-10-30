import mongoose, { type Model, type Types } from 'mongoose';

export interface SessionDocument {
  name: string;
  startDate: Date;
  endDate: Date;
  isCurrent: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface TermDocument {
  sessionId: Types.ObjectId;
  name: string;
  startDate: Date;
  endDate: Date;
  isCurrent: boolean;
  /** A closed term. Its details can no longer be edited. */
  locked: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const sessionSchema = new mongoose.Schema<SessionDocument>(
  {
    name: { type: String, required: true, trim: true, maxlength: 20 },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    isCurrent: { type: Boolean, default: false },
  },
  { timestamps: true, versionKey: false },
);
sessionSchema.index({ name: 1 }, { unique: true });
// Only one document may have isCurrent: true. The database enforces "one current session".
sessionSchema.index({ isCurrent: 1 }, { unique: true, partialFilterExpression: { isCurrent: true } });
sessionSchema.index({ startDate: -1 });

const termSchema = new mongoose.Schema<TermDocument>(
  {
    sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Session', required: true },
    name: { type: String, required: true, trim: true, maxlength: 40 },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    isCurrent: { type: Boolean, default: false },
    locked: { type: Boolean, default: false },
  },
  { timestamps: true, versionKey: false },
);
termSchema.index({ sessionId: 1, name: 1 }, { unique: true });
termSchema.index({ isCurrent: 1 }, { unique: true, partialFilterExpression: { isCurrent: true } });
termSchema.index({ sessionId: 1, startDate: 1 });

export const SessionModel: Model<SessionDocument> =
  (mongoose.models.Session as Model<SessionDocument> | undefined) ??
  mongoose.model<SessionDocument>('Session', sessionSchema);

export const TermModel: Model<TermDocument> =
  (mongoose.models.Term as Model<TermDocument> | undefined) ??
  mongoose.model<TermDocument>('Term', termSchema);