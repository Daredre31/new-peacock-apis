import mongoose, { type Model } from 'mongoose';
import type { AssessmentConfig } from './assessment';

export interface SchoolProfile {
  name: string; shortName: string | null; motto: string | null; address: string | null;
  phone: string | null; email: string | null; website: string | null;
}
export interface SchoolPolicy {
  /** Used by Phase 4: parents see "withheld" instead of the report card while fees are owed. */
  withholdReportsIfOwing: boolean;
  teacherPostsNeedApproval: boolean;
  lowAttendancePercent: number;
  lowScorePercent: number;
}

export const DEFAULT_PROFILE: SchoolProfile = {
  name: 'Peacock Academy', shortName: null, motto: null, address: null, phone: null, email: null, website: null,
};
export const DEFAULT_POLICY: SchoolPolicy = {
  withholdReportsIfOwing: false, teacherPostsNeedApproval: true, lowAttendancePercent: 75, lowScorePercent: 40,
};

interface SettingsDocument {
  _id: string;
  assessment: AssessmentConfig | null;
  profile: Partial<SchoolProfile> | null;
  policy: Partial<SchoolPolicy> | null;
  updatedBy: mongoose.Types.ObjectId | null;
  updatedAt: Date;
}

const schema = new mongoose.Schema<SettingsDocument>(
  {
    _id: { type: String, required: true },
    assessment: { type: mongoose.Schema.Types.Mixed, default: null },
    profile: { type: mongoose.Schema.Types.Mixed, default: null },
    policy: { type: mongoose.Schema.Types.Mixed, default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: { createdAt: false, updatedAt: true }, versionKey: false },
);

const SettingsModel: Model<SettingsDocument> =
  (mongoose.models.Settings as Model<SettingsDocument> | undefined) ??
  mongoose.model<SettingsDocument>('Settings', schema);

const DOC_ID = 'school'; // one settings document for the whole school

const load = (): Promise<SettingsDocument | null> => SettingsModel.findById(DOC_ID).lean<SettingsDocument>();

async function save(field: 'assessment' | 'profile' | 'policy', value: unknown, updatedBy: string): Promise<void> {
  const set: Record<string, unknown> = { [field]: value, updatedBy };
  await SettingsModel.updateOne({ _id: DOC_ID }, { $set: set }, { upsert: true });
}

export const settingsRepository = {
  getAssessment: async (): Promise<AssessmentConfig | null> => (await load())?.assessment ?? null,
  getProfile: async (): Promise<SchoolProfile> => ({ ...DEFAULT_PROFILE, ...((await load())?.profile ?? {}) }),
  getPolicy: async (): Promise<SchoolPolicy> => ({ ...DEFAULT_POLICY, ...((await load())?.policy ?? {}) }),
  saveAssessment: (config: AssessmentConfig, by: string): Promise<void> => save('assessment', config, by),
  saveProfile: (profile: SchoolProfile, by: string): Promise<void> => save('profile', profile, by),
  savePolicy: (policy: SchoolPolicy, by: string): Promise<void> => save('policy', policy, by),
};