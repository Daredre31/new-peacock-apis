import mongoose, { type Model } from 'mongoose';
import { SCHOOL_NAME } from '../../config/constants';
import type { AssessmentConfig } from './assessment';

export interface SchoolProfile {
  name: string; shortName: string | null; motto: string | null; address: string | null;
  phone: string | null; email: string | null; website: string | null;
}
/** What printed documents (report cards, exam results) carry besides the profile text. The images live in Cloudinary and only their URLs are kept. */
export interface SchoolBranding {
  logoUrl: string | null;
  principalName: string | null;
  principalSignatureUrl: string | null;
  stampUrl: string | null;
}
export interface SchoolPolicy {
  /** Used by Phase 4: parents see "withheld" instead of the report card while fees are owed. */
  withholdReportsIfOwing: boolean;
  teacherPostsNeedApproval: boolean;
  lowAttendancePercent: number;
  lowScorePercent: number;
  /** Added to every online payment and paid by the parent, in kobo. 10000 = NGN 100. Offline payments carry no fee. */
  onlinePaymentFeeKobo: number;
  /** The smallest part payment, as a percent of the invoice total (or the whole balance if that is smaller). */
  minPartPaymentPercent: number;
  /**
   * true: a student must change the temporary password at first login (new students and admin resets).
   * false: they can use it straight away. Staff and parents are always forced, whatever this says.
   */
  studentsMustChangePassword: boolean;
  /** A student whose yearly average reaches this percent is promoted. Below it, they repeat. */
  promotionPassMarkPercent: number;
}

export const DEFAULT_PROFILE: SchoolProfile = {
  name: SCHOOL_NAME, shortName: null, motto: null, address: null, phone: null, email: null, website: null,
};
export const DEFAULT_BRANDING: SchoolBranding = { logoUrl: null, principalName: null, principalSignatureUrl: null, stampUrl: null };
export const DEFAULT_POLICY: SchoolPolicy = {
  withholdReportsIfOwing: false, teacherPostsNeedApproval: true, lowAttendancePercent: 75, lowScorePercent: 40,
  studentsMustChangePassword: true, onlinePaymentFeeKobo: 10_000, minPartPaymentPercent: 2,// today's behaviour until the super admin turns it off
  promotionPassMarkPercent: 40,
};

interface SettingsDocument {
  _id: string;
  assessment: AssessmentConfig | null;
  profile: Partial<SchoolProfile> | null;
  /** Absent until first set. Written field by field, so never default it to null: a dotted $set cannot go inside null. */
  branding?: Partial<SchoolBranding>;
  policy: Partial<SchoolPolicy> | null;
  updatedBy: mongoose.Types.ObjectId | null;
  updatedAt: Date;
}

const schema = new mongoose.Schema<SettingsDocument>(
  {
    _id: { type: String, required: true },
    assessment: { type: mongoose.Schema.Types.Mixed, default: null },
    profile: { type: mongoose.Schema.Types.Mixed, default: null },
    branding: { type: mongoose.Schema.Types.Mixed },
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

/** Sets one branding field without touching the others, so two admins changing different things never overwrite each other. */
async function setBrandingField(field: keyof SchoolBranding, value: string | null, updatedBy: string): Promise<void> {
  await SettingsModel.updateOne({ _id: DOC_ID }, { $set: { [`branding.${field}`]: value, updatedBy } }, { upsert: true });
}

export const settingsRepository = {
  getBranding: async (): Promise<SchoolBranding> => ({ ...DEFAULT_BRANDING, ...((await load())?.branding ?? {}) }),
  setBrandingField,
  getAssessment: async (): Promise<AssessmentConfig | null> => (await load())?.assessment ?? null,
  getProfile: async (): Promise<SchoolProfile> => ({ ...DEFAULT_PROFILE, ...((await load())?.profile ?? {}) }),
  getPolicy: async (): Promise<SchoolPolicy> => ({ ...DEFAULT_POLICY, ...((await load())?.policy ?? {}) }),
  saveAssessment: (config: AssessmentConfig, by: string): Promise<void> => save('assessment', config, by),
  saveProfile: (profile: SchoolProfile, by: string): Promise<void> => save('profile', profile, by),
  savePolicy: (policy: SchoolPolicy, by: string): Promise<void> => save('policy', policy, by),
};