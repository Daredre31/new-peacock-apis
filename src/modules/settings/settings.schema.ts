import { z } from 'zod';
import { PERMISSIONS } from '../../config/constants';
import type { OpenApiRegistry } from '../../openapi/registry';

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

export function registerSettingsOperations(registry: OpenApiRegistry): void {
  const tags = ['settings'];
  registry.register({ method: 'get', path: '/settings/grading-scale', operationId: 'getGradingScale', summary: 'Score components (for example CA1, CA2, EXAM) and grade bands', tags, roles: PERMISSIONS['grading-scale:read'], success: { status: 200, description: 'The scale', data: assessmentBody } });
  registry.register({ method: 'put', path: '/settings/grading-scale', operationId: 'setGradingScale', summary: 'Replace the scale. Component maximums must add up to 100. Components cannot change once scores exist', tags, roles: PERMISSIONS['grading-scale:write'], request: { body: assessmentBody }, success: { status: 200, description: 'Saved', data: assessmentBody }, errors: ['CONFLICT'] });
}