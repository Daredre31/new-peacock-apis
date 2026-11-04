import { AppError } from '../../common/errors/AppError';
import { normalizeEmail, normalizePhone } from '../../common/utils/identifier';
import { sanitizeText } from '../../common/utils/text';
import { ROLES, type Role } from '../../config/constants';
import { recordSafely, type AuditPort } from '../audit/audit.port';
import { DEFAULT_ASSESSMENT, assessmentIssues, type AssessmentConfig } from './assessment';
import type { SchoolPolicy, SchoolProfile, settingsRepository } from './settings.repository';

export type ProfilePatch = { [K in keyof SchoolProfile]?: SchoolProfile[K] | undefined };
export type PolicyPatch = { [K in keyof SchoolPolicy]?: SchoolPolicy[K] | undefined };

interface Actor { id: string }
interface Context { ip: string; requestId: string }

const fail = (field: string, issue: string): AppError => new AppError('VALIDATION_ERROR', { details: [{ field, issue }] });

function cleanText(field: string, value: string | null | undefined, max: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = sanitizeText(value);
  if (text.length > max) throw fail(field, `At most ${max} characters`);
  return text || null;
}

function mergeProfile(before: SchoolProfile, patch: ProfilePatch): SchoolProfile {
  const next: SchoolProfile = { ...before };

  if (patch.name !== undefined) {
    const name = cleanText('profile.name', patch.name, 100);
    if (!name) throw fail('profile.name', 'The school needs a name');
    next.name = name;
  }
  for (const [key, max] of [['shortName', 30], ['motto', 150], ['address', 250]] as const) {
    const value = cleanText(`profile.${key}`, patch[key], max);
    if (value !== undefined) next[key] = value;
  }
  if (patch.email !== undefined) {
    const raw = cleanText('profile.email', patch.email, 254);
    next.email = raw ? (normalizeEmail(raw) ?? (() => { throw fail('profile.email', 'Invalid email address'); })()) : null;
  }
  if (patch.phone !== undefined) {
    const raw = cleanText('profile.phone', patch.phone, 30);
    next.phone = raw ? (normalizePhone(raw) ?? (() => { throw fail('profile.phone', 'Invalid phone number'); })()) : null;
  }
  if (patch.website !== undefined) {
    const raw = cleanText('profile.website', patch.website, 200);
    if (raw) {
      let url: URL | null = null;
      try { url = new URL(raw); } catch { url = null; }
      if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) throw fail('profile.website', 'Must be a web address starting with https://');
      next.website = url.toString();
    } else next.website = null;
  }
  return next;
}

export function createSettingsService(deps: {
  repo: typeof settingsRepository;
  audit: AuditPort;
  /** True once any score exists, because changing the score components would corrupt totals. */
  assessmentInUse?: () => Promise<boolean>;
}) {
  const { repo, audit } = deps;
  const getAssessment = async (): Promise<AssessmentConfig> => (await repo.getAssessment()) ?? DEFAULT_ASSESSMENT;

  return {
    getAssessment,
    getProfile: (): Promise<SchoolProfile> => repo.getProfile(),
    getPolicy: (): Promise<SchoolPolicy> => repo.getPolicy(),

    async setAssessment(config: AssessmentConfig, actor: Actor, ctx: Context): Promise<AssessmentConfig> {
      const issues = assessmentIssues(config);
      if (issues.length > 0) throw new AppError('VALIDATION_ERROR', { details: issues });

      const before = await getAssessment();
      const componentsChanged = JSON.stringify(before.components) !== JSON.stringify(config.components);
      if (componentsChanged && deps.assessmentInUse && (await deps.assessmentInUse())) {
        throw new AppError('CONFLICT', { message: 'Scores already exist, so the score components cannot change. You can still change the grade bands.' });
      }

      await repo.saveAssessment(config, actor.id);
      await recordSafely(audit, {
        action: 'GRADING_SCALE_CHANGED', actorId: actor.id, entityType: 'settings', entityId: 'assessment',
        ip: ctx.ip, requestId: ctx.requestId, before: { ...before }, after: { ...config },
      });
      return config;
    },

    /** Everyone gets the school profile. Only the super admin gets the policy flags. */
    async view(role: Role) {
      const [profile, policy] = await Promise.all([repo.getProfile(), role === ROLES.SUPER_ADMIN ? repo.getPolicy() : Promise.resolve(null)]);
      return { profile, policy };
    },

    async update(input: { profile?: ProfilePatch | undefined; policy?: PolicyPatch | undefined }, actor: Actor, ctx: Context) {
      if (!input.profile && !input.policy) throw fail('body', 'Nothing to update');
      const [beforeProfile, beforePolicy] = await Promise.all([repo.getProfile(), repo.getPolicy()]);

      const profile = input.profile ? mergeProfile(beforeProfile, input.profile) : beforeProfile;
      const policy: SchoolPolicy = input.policy
        ? Object.fromEntries(Object.entries({ ...beforePolicy, ...input.policy }).filter(([, v]) => v !== undefined)) as unknown as SchoolPolicy
        : beforePolicy;

      if (input.profile) await repo.saveProfile(profile, actor.id);
      if (input.policy) await repo.savePolicy(policy, actor.id);

      await recordSafely(audit, {
        action: 'SETTINGS_CHANGED', actorId: actor.id, entityType: 'settings', entityId: 'school', ip: ctx.ip, requestId: ctx.requestId,
        before: { profile: beforeProfile, policy: beforePolicy }, after: { profile, policy },
      });
      return { profile, policy };
    },
  };
}

export type SettingsService = ReturnType<typeof createSettingsService>;