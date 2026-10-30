import mongoose, { type Model } from 'mongoose';

export interface AuditLogDocument {
  action: string;
  actorId?: string | null;
  entityType?: string;
  entityId?: string;
  ip?: string;
  requestId?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  createdAt: Date;
}

const MESSAGE = 'Audit log entries are append-only';

const schema = new mongoose.Schema<AuditLogDocument>(
  {
    action: { type: String, required: true, maxlength: 64 },
    actorId: { type: String, default: null },
    entityType: { type: String, maxlength: 40 },
    entityId: { type: String, maxlength: 64 },
    ip: { type: String, maxlength: 64 },
    requestId: { type: String, maxlength: 64 },
    before: { type: mongoose.Schema.Types.Mixed, default: null },
    after: { type: mongoose.Schema.Types.Mixed, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false, minimize: false },
);

schema.index({ createdAt: -1 });
schema.index({ actorId: 1, createdAt: -1 });
schema.index({ action: 1, createdAt: -1 });
schema.index({ entityType: 1, entityId: 1, createdAt: -1 });

// No update or delete is possible through the model. Only create and read exist.
const BLOCKED = [
  'updateOne',
  'updateMany',
  'replaceOne',
  'findOneAndUpdate',
  'findOneAndReplace',
  'findOneAndDelete',
  'deleteOne',
  'deleteMany',
] as const;

schema.pre([...BLOCKED], function () {
  throw new Error(MESSAGE);
});
schema.pre('save', function () {
  if (!this.isNew) throw new Error(MESSAGE);
});

export const AuditLogModel: Model<AuditLogDocument> =
  (mongoose.models.AuditLog as Model<AuditLogDocument> | undefined) ??
  mongoose.model<AuditLogDocument>('AuditLog', schema);