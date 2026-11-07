import { randomInt } from 'node:crypto';
import type { Difficulty, QuestionType } from './cbt.types';

export interface PaperQuestion { id: string; type: QuestionType; text: string; options: { key: string; text: string }[] | null; marks: number }
export interface KeyedQuestion extends PaperQuestion { correctAnswer: string | string[] }
export interface StoredQuestion extends KeyedQuestion { order: number; topic: string | null; difficulty: Difficulty; explanation: string | null }

const round1 = (n: number): number => Math.round(n * 10) / 10;
const CONTROL = /[\u0000-\u001f\u007f]/g;

export function normalizeAnswer(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
}

export function isCorrect(q: KeyedQuestion, answer: string | undefined): boolean {
  if (answer === undefined) return false;
  switch (q.type) {
    case 'MCQ': return answer === q.correctAnswer;
    case 'TRUE_FALSE': return answer.toUpperCase() === q.correctAnswer;
    case 'SHORT_ANSWER': return Array.isArray(q.correctAnswer) && q.correctAnswer.includes(normalizeAnswer(answer));
    default: return false;
  }
}

export function gradeAttempt(questions: readonly KeyedQuestion[], answers: Record<string, string>) {
  let score = 0;
  let maxScore = 0;
  let correctCount = 0;
  for (const q of questions) {
    maxScore += q.marks;
    if (isCorrect(q, answers[q.id])) { score += q.marks; correctCount += 1; }
  }
  return { score: round1(score), maxScore: round1(maxScore), correctCount };
}

/** Fisher-Yates with a cryptographic random source. */
export function shuffle<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** The value to store, null to clear the answer, or undefined if it is not a valid answer to this question. */
export function cleanAnswer(q: PaperQuestion, value: string | null): string | null | undefined {
  if (value === null || value.trim() === '') return null;
  if (q.type === 'MCQ') {
    const key = value.trim().toUpperCase();
    return q.options?.some((o) => o.key === key) ? key : undefined;
  }
  if (q.type === 'TRUE_FALSE') {
    const v = value.trim().toUpperCase();
    return v === 'TRUE' || v === 'FALSE' ? v : undefined;
  }
  const text = value.replace(CONTROL, '').trim();
  return text.length > 0 && text.length <= 200 ? text : undefined;
}