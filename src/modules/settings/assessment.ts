export interface AssessmentComponent { key: string; name: string; max: number }
export interface GradeBand { grade: string; min: number; remark: string }
export interface AssessmentConfig { components: AssessmentComponent[]; bands: GradeBand[] }

/** Used until the super admin saves their own. Two continuous assessments and an exam, out of 100. */
export const DEFAULT_ASSESSMENT: AssessmentConfig = {
  components: [
    { key: 'CA1', name: 'First CA', max: 20 },
    { key: 'CA2', name: 'Second CA', max: 20 },
    { key: 'EXAM', name: 'Exam', max: 60 },
  ],
  bands: [
    { grade: 'A', min: 70, remark: 'Excellent' },
    { grade: 'B', min: 60, remark: 'Very good' },
    { grade: 'C', min: 50, remark: 'Good' },
    { grade: 'D', min: 45, remark: 'Fair' },
    { grade: 'E', min: 40, remark: 'Pass' },
    { grade: 'F', min: 0, remark: 'Fail' },
  ],
};

export function assessmentIssues(config: AssessmentConfig): { field: string; issue: string }[] {
  const issues: { field: string; issue: string }[] = [];

  const keys = new Set<string>();
  config.components.forEach((c, i) => {
    if (keys.has(c.key)) issues.push({ field: `components.${i}.key`, issue: 'Duplicate key' });
    keys.add(c.key);
  });
  const total = config.components.reduce((sum, c) => sum + c.max, 0);
  if (total !== 100) issues.push({ field: 'components', issue: `Maximum scores must add up to 100 (they add up to ${total})` });

  const grades = new Set<string>();
  const mins = new Set<number>();
  config.bands.forEach((b, i) => {
    if (grades.has(b.grade)) issues.push({ field: `bands.${i}.grade`, issue: 'Duplicate grade' });
    if (mins.has(b.min)) issues.push({ field: `bands.${i}.min`, issue: 'Duplicate starting mark' });
    grades.add(b.grade);
    mins.add(b.min);
  });
  if (!mins.has(0)) issues.push({ field: 'bands', issue: 'One band must start at 0, so every mark has a grade' });
  return issues;
}

/** The band a total falls in: the highest band whose starting mark it reaches. */
export function gradeFor(total: number, bands: readonly GradeBand[]): GradeBand {
  const sorted = [...bands].sort((a, b) => b.min - a.min);
  return sorted.find((band) => total >= band.min) ?? { grade: '', min: 0, remark: '' };
}