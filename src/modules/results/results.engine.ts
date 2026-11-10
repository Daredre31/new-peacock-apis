import type { AssessmentConfig } from '../settings/assessment';

export type Components = Record<string, number | null>;

const round1 = (n: number): number => Math.round(n * 10) / 10;

export function totalOf(components: Components, config: AssessmentConfig): { total: number; complete: boolean } {
  let total = 0;
  let complete = true;
  for (const c of config.components) {
    const value = components[c.key];
    if (typeof value === 'number') total += value;
    else complete = false;
  }
  return { total: round1(total), complete };
}

/** Competition ranking: equal totals share a position, and the next position skips (1, 2, 2, 4). */
export function rankByTotal(totals: Map<string, number>): Map<string, number> {
  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const result = new Map<string, number>();
  let position = 0;
  let previous: number | null = null;
  sorted.forEach(([id, value], index) => {
    if (value !== previous) {
      position = index + 1;
      previous = value;
    }
    result.set(id, position);
  });
  return result;
}

export const averageOf = (sum: number, count: number): number | null => (count === 0 ? null : round1(sum / count));
export const round = round1;

export interface AnnualScoreInput { termId: string; subjectId: string; total: number }
export interface AnnualOutcome {
  /** How many different terms the student has published results in. */
  termsWithResults: number;
  termAverages: { termId: string; average: number }[];
  subjects: { subjectId: string; average: number; termsCounted: number }[];
  /** The mean of the subject averages, or null when there are no results at all. */
  average: number | null;
}

/**
 * The yearly (cumulative) average. Each subject is averaged over the terms it has a result in,
 * then the subjects are averaged, so every subject weighs the same. Rounding happens once, at the end.
 */
export function annualOf(scores: readonly AnnualScoreInput[]): AnnualOutcome {
  const bySubject = new Map<string, { sum: number; count: number }>();
  const byTerm = new Map<string, { sum: number; count: number }>();
  for (const s of scores) {
    if (!Number.isFinite(s.total)) continue;
    const sub = bySubject.get(s.subjectId) ?? { sum: 0, count: 0 };
    bySubject.set(s.subjectId, { sum: sub.sum + s.total, count: sub.count + 1 });
    const term = byTerm.get(s.termId) ?? { sum: 0, count: 0 };
    byTerm.set(s.termId, { sum: term.sum + s.total, count: term.count + 1 });
  }

  const exact = [...bySubject.entries()].map(([subjectId, v]) => ({ subjectId, mean: v.sum / v.count, termsCounted: v.count }));
  const average = exact.length === 0 ? null : round1(exact.reduce((sum, v) => sum + v.mean, 0) / exact.length);
  return {
    termsWithResults: byTerm.size,
    termAverages: [...byTerm.entries()].map(([termId, v]) => ({ termId, average: round1(v.sum / v.count) })),
    subjects: exact.map((v) => ({ subjectId: v.subjectId, average: round1(v.mean), termsCounted: v.termsCounted })),
    average,
  };
}
