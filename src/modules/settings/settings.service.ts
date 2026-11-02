import { AppError } from '../../common/errors/AppError';
import { recordSafely, type AuditPort } from '../audit/audit.port';
import { DEFAULT_ASSESSMENT, assessmentIssues, type AssessmentConfig } from './assessment';
import type { settingsRepository } from './settings.repository';

export function createSettingsService(deps: {
  repo: typeof settingsRepository;
  audit: AuditPort;
  /** Part B wires this: true once any score exists, because changing components would corrupt totals. */
  assessmentInUse?: () => Promise<boolean>;
}) {
  const getAssessment = async (): Promise<AssessmentConfig> => (await deps.repo.getAssessment()) ?? DEFAULT_ASSESSMENT;

  return {
    getAssessment,

    async setAssessment(config: AssessmentConfig, actor: { id: string }, ctx: { ip: string; requestId: string }): Promise<AssessmentConfig> {
      const issues = assessmentIssues(config);
      if (issues.length > 0) throw new AppError('VALIDATION_ERROR', { details: issues });

      const before = await getAssessment();
      const componentsChanged = JSON.stringify(before.components) !== JSON.stringify(config.components);
      if (componentsChanged && deps.assessmentInUse && (await deps.assessmentInUse())) {
        throw new AppError('CONFLICT', { message: 'Scores already exist, so the score components cannot change. You can still change the grade bands.' });
      }

      await deps.repo.saveAssessment(config, actor.id);
      await recordSafely(deps.audit, {
        action: 'GRADING_SCALE_CHANGED', actorId: actor.id, entityType: 'settings', entityId: 'assessment',
        ip: ctx.ip, requestId: ctx.requestId, before: { ...before }, after: { ...config },
      });
      return config;
    },
  };
}

export type SettingsService = ReturnType<typeof createSettingsService>;