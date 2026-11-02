import { AppError, type ErrorDetail } from '../../common/errors/AppError';
import type { AssessmentConfig } from '../settings/assessment';
import { totalOf, type Components } from './results.engine';
import { SCORE_STATUS, type ScoreRecord, type ScoreWrite } from './score.repository';

export type EditVerdict = 'OK' | 'LOCKED' | 'SUBMITTED' | 'MISSING';
export interface PlanEntry { studentId: string; subjectId: string; components: Record<string, number | null> }
export interface PlanChange { studentId: string; subjectId: string; before: Components; after: Components }

export const scoreKey = (studentId: string, subjectId: string): string => `${studentId}|${subjectId}`;
const oneDecimal = (n: number): boolean => Math.abs(n * 10 - Math.round(n * 10)) < 1e-9;

/** A teacher edits their own drafts. After a super admin unlock they can also correct published scores. */
export const teacherCanEdit = (doc: ScoreRecord | undefined): EditVerdict => {
  if (!doc || doc.status === SCORE_STATUS.DRAFT) return 'OK';
  if (doc.status === SCORE_STATUS.PUBLISHED) return doc.locked ? 'LOCKED' : 'OK';
  return 'SUBMITTED';
};

/** An admin adjusts any existing score that is not locked. */
export const adminCanEdit = (doc: ScoreRecord | undefined): EditVerdict => {
  if (!doc) return 'MISSING';
  return doc.locked ? 'LOCKED' : 'OK';
};

export function planWrites(args: {
  armId: string; termId: string; entries: PlanEntry[]; existing: Map<string, ScoreRecord>;
  enrolled: Set<string>; config: AssessmentConfig; canEdit: (doc: ScoreRecord | undefined) => EditVerdict;
}): { writes: ScoreWrite[]; changes: PlanChange[] } {
  const details: ErrorDetail[] = [];
  const seen = new Set<string>();
  const writes: ScoreWrite[] = [];
  const changes: PlanChange[] = [];
  const max = new Map(args.config.components.map((c) => [c.key, c.max]));

  args.entries.forEach((entry, i) => {
    const key = scoreKey(entry.studentId, entry.subjectId);
    if (seen.has(key)) { details.push({ field: `entries.${i}.studentId`, issue: 'Listed twice' }); return; }
    seen.add(key);
    if (!args.enrolled.has(entry.studentId)) { details.push({ field: `entries.${i}.studentId`, issue: 'Not enrolled in this class arm' }); return; }

    const provided = Object.entries(entry.components);
    if (provided.length === 0) { details.push({ field: `entries.${i}.components`, issue: 'No scores given' }); return; }

    let valid = true;
    for (const [component, value] of provided) {
      const limit = max.get(component);
      if (limit === undefined) { details.push({ field: `entries.${i}.components.${component}`, issue: 'Unknown score component' }); valid = false; }
      else if (value !== null && (value < 0 || value > limit)) { details.push({ field: `entries.${i}.components.${component}`, issue: `Must be between 0 and ${limit}` }); valid = false; }
      else if (value !== null && !oneDecimal(value)) { details.push({ field: `entries.${i}.components.${component}`, issue: 'At most one decimal place' }); valid = false; }
    }
    if (!valid) return;

    const existing = args.existing.get(key);
    const verdict = args.canEdit(existing);
    if (verdict === 'LOCKED') throw new AppError('RESULT_LOCKED');
    if (verdict === 'SUBMITTED') throw new AppError('CONFLICT', { message: 'These scores were already submitted for moderation' });
    if (verdict === 'MISSING') { details.push({ field: `entries.${i}.studentId`, issue: 'No score exists yet' }); return; }

    const before: Components = { ...(existing?.components ?? {}) };
    const after: Components = { ...before };
    for (const [component, value] of provided) after[component] = value;

    writes.push({
      studentId: entry.studentId, classArmId: args.armId, subjectId: entry.subjectId, termId: args.termId,
      components: after, total: totalOf(after, args.config).total,
      expect: existing ? { rev: existing.rev, status: existing.status, locked: existing.locked } : { rev: 0, status: SCORE_STATUS.DRAFT, locked: false },
    });
    changes.push({ studentId: entry.studentId, subjectId: entry.subjectId, before, after });
  });

  if (details.length > 0) throw new AppError('VALIDATION_ERROR', { details: details.slice(0, 50) });
  return { writes, changes };
}