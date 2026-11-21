import { randomInt } from 'node:crypto';
import { MAX_ANSWER_CHARS, type Difficulty, type QuestionType } from './cbt.types';

export interface PaperQuestion {
  id: string; type: QuestionType; text: string; options: { key: string; text: string }[] | null; marks: number;
  /** The diagram, if the teacher attached one. Optional so a paper cached before pictures existed still reads. */
  imageUrl?: string | null; imageWidth?: number | null; imageHeight?: number | null;
}
export interface KeyedQuestion extends PaperQuestion { correctAnswer: string | string[] }
export interface StoredQuestion extends KeyedQuestion { imageFileName?: string | null; order: number; topic: string | null; difficulty: Difficulty; explanation: string | null }

const round1 = (n: number): number => Math.round(n * 10) / 10;
/** Every control character except the line break, so a paragraph keeps its paragraphs. */
const CONTROL_KEEP_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f]/g;

export function normalizeAnswer(value: string): string {
  const text = value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  // Cut trailing full stops and spaces with a plain loop: a regex for this is slow on long text full of dots and spaces.
  let end = text.length;
  while (end > 0 && (text[end - 1] === '.' || text[end - 1] === ' ')) end -= 1;
  return text.slice(0, end);
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
  const text = value.replace(/\r\n?/g, '\n').replace(CONTROL_KEEP_NEWLINE, '').trim();
  return text.length > 0 && text.length <= MAX_ANSWER_CHARS ? text : undefined;
}