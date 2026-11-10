import { z } from 'zod';
import { PERMISSIONS, ROLES } from '../../config/constants';
import type { OpenApiRegistry } from '../../openapi/registry';

// ---- grading scale
const component = z.object({
  key: z.string().regex(/^[A-Z][A-Z0-9]{0,7}$/, 'Use capital letters and digits, like CA1'),
  name: z.string().trim().min(2).max(30),
  max: z.number().int().min(1).max(100),
});
const band = z.object({
  grade: z.string().regex(/^[A-Z][A-Za-z0-9+-]{0,3}$/),
  min: z.number().int().min(0).max(100),
  remark: z.string().trim().min(1).max(30),
});
export const assessmentBody = z.object({
  components: z.array(component).min(1).max(6),
  bands: z.array(band).min(2).max(12),
});
export const setGradingScaleSchemas = { body: assessmentBody };

// ---- school profile and policy
const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();
const profileBody = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  shortName: nullableText(30), motto: nullableText(150), address: nullableText(250),
  phone: nullableText(30), email: nullableText(254), website: nullableText(200),
}).strict();
const policyBody = z.object({
  withholdReportsIfOwing: z.boolean().optional(),
  teacherPostsNeedApproval: z.boolean().optional(),
  lowAttendancePercent: z.number().int().min(1).max(100).optional(),
  lowScorePercent: z.number().int().min(1).max(100).optional(),
     onlinePaymentFeeKobo: z.number().int().min(0).max(1_000_000).optional(),
  minPartPaymentPercent: z.number().int().min(1).max(100).optional(),
  studentsMustChangePassword: z.boolean().optional(),
  promotionPassMarkPercent: z.number().int().min(1).max(100).optional(),
}).strict();
export const updateSettingsBody = z.object({ profile: profileBody.optional(), policy: policyBody.optional() });
export const updateSettingsSchemas = { body: updateSettingsBody };

const profileView = z.object({
  name: z.string(), shortName: z.string().nullable(), motto: z.string().nullable(), address: z.string().nullable(),
  phone: z.string().nullable(), email: z.string().nullable(), website: z.string().nullable(),
});
const policyView = z.object({
  withholdReportsIfOwing: z.boolean(), teacherPostsNeedApproval: z.boolean(),
  lowAttendancePercent: z.number().int(), lowScorePercent: z.number().int(),
  studentsMustChangePassword: z.boolean(),
  onlinePaymentFeeKobo: z.number().int(), minPartPaymentPercent: z.number().int(), promotionPassMarkPercent: z.number().int(),
});

export function registerSettingsOperations(registry: OpenApiRegistry): void {
  const tags = ['settings'];
  registry.register({ method: 'get', path: '/settings/grading-scale', operationId: 'getGradingScale', summary: 'Score components (for example CA1, CA2, EXAM) and grade bands', tags, roles: PERMISSIONS['grading-scale:read'], success: { status: 200, description: 'The scale', data: assessmentBody } });
  registry.register({ method: 'put', path: '/settings/grading-scale', operationId: 'setGradingScale', summary: 'Replace the scale. Component maximums must add up to 100. Components cannot change once scores exist', tags, roles: PERMISSIONS['grading-scale:write'], request: { body: assessmentBody }, success: { status: 200, description: 'Saved', data: assessmentBody }, errors: ['CONFLICT'] });
  registry.register({ method: 'get', path: '/settings', operationId: 'getSettings', summary: 'The school profile (everyone). The policy flags are returned to the super admin only, and are null for everyone else', tags, roles: PERMISSIONS['session:self'], success: { status: 200, description: 'Settings', data: z.object({ profile: profileView, policy: policyView.nullable() }) } });
  registry.register({ method: 'put', path: '/settings', operationId: 'updateSettings', summary: 'Change the school profile and/or the policy flags. Only the fields you send change; send null to clear an optional profile field. Sending policy.studentsMustChangePassword = false also clears the "must change password" flag on every existing student at once', tags, roles: [ROLES.SUPER_ADMIN], request: { body: updateSettingsBody }, success: { status: 200, description: 'Saved', data: z.object({ profile: profileView, policy: policyView }) } });
}