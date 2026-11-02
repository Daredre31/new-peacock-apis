import mongoose, { type Model } from 'mongoose';
import type { AssessmentConfig } from './assessment';

interface SettingsDocument {
  _id: string;
  assessment: AssessmentConfig | null;
  updatedBy: mongoose.Types.ObjectId | null;
  updatedAt: Date;
}

const schema = new mongoose.Schema<SettingsDocument>(
  {
    _id: { type: String, required: true },
    assessment: { type: mongoose.Schema.Types.Mixed, default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: { createdAt: false, updatedAt: true }, versionKey: false },
);

const SettingsModel: Model<SettingsDocument> =
  (mongoose.models.Settings as Model<SettingsDocument> | undefined) ??
  mongoose.model<SettingsDocument>('Settings', schema);

const DOC_ID = 'school'; // one settings document for the whole school

async function getAssessment(): Promise<AssessmentConfig | null> {
  const row = await SettingsModel.findById(DOC_ID).lean<SettingsDocument>();
  return row?.assessment ?? null;
}

async function saveAssessment(config: AssessmentConfig, updatedBy: string): Promise<void> {
  await SettingsModel.updateOne({ _id: DOC_ID }, { $set: { assessment: config, updatedBy } }, { upsert: true });
}

export const settingsRepository = { getAssessment, saveAssessment };