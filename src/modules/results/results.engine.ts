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