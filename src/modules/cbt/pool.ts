import { shuffle } from './grading';

export interface PoolIssue { field: string; issue: string }

/**
 * Checks that "each student gets N of the exam's questions" can work. Nothing to check until questions exist.
 * When students get only some of the questions, every question must carry the same marks: that is what makes
 * every student's paper worth the same total, so scores stay comparable.
 */
export function poolIssue(perStudent: number | null, questionCount: number, marks: readonly number[]): PoolIssue | null {
  if (perStudent === null || questionCount === 0) return null;
  if (perStudent > questionCount) {
    return { field: 'settings.questionsPerStudent', issue: `Students cannot be given ${perStudent} questions when the exam has only ${questionCount}` };
  }
  if (perStudent < questionCount && new Set(marks).size > 1) {
    return { field: 'marks', issue: 'When students get a random selection, every question must carry the same marks, so every student is marked out of the same total' };
  }
  return null;
}

/**
 * The questions one student will sit, in the order they will see them. With a pool, a uniformly random
 * subset is drawn from the whole bank using the server's cryptographic randomness. Without one, the student gets all of them.
 * Turning shuffleOrder off keeps the teacher's order, with the drawn questions in their original places.
 */
export function chooseQuestions(ids: readonly string[], perStudent: number | null, shuffleOrder: boolean): string[] {
  const sampling = perStudent !== null && perStudent < ids.length;
  const chosen = sampling ? shuffle(ids).slice(0, perStudent) : [...ids];
  if (!shuffleOrder) {
    const position = new Map(ids.map((id, i) => [id, i]));
    return chosen.sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0));
  }
  return sampling ? chosen : shuffle(chosen);
}
