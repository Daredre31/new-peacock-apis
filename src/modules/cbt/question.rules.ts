import { createHash } from 'node:crypto';
import { normalizeImageFileName } from '../../common/utils/image';
import { DIFFICULTIES, OPTION_KEYS, QUESTION_TYPES, type Difficulty, type QuestionType } from './cbt.types';
import { normalizeAnswer } from './grading';

/**
 * The rules one question must meet, the same ones the spreadsheet import applies to every row, for questions
 * added or edited by hand. Pure: it reads its input and returns either a clean question or every problem found.
 */
export interface QuestionInput {
  type: string;
  text: string;
  /** MCQ only: the option texts in order. Letters A to E are given automatically. */
  options?: readonly string[] | null | undefined;
  /** MCQ: the letter. TRUE_FALSE: TRUE or FALSE. SHORT_ANSWER: the accepted answers (or one string with answers split by |). */
  correctAnswer: string | readonly string[];
  marks?: number | undefined;
  topic?: string | null | undefined;
  difficulty?: string | undefined;
  explanation?: string | null | undefined;
  imageFileName?: string | null | undefined;
}

export interface QuestionIssue { field: string; issue: string }

export interface BuiltQuestion {
  type: QuestionType;
  text: string;
  options: { key: string; text: string }[] | null;
  correctAnswer: string | string[];
  marks: number;
  topic: string | null;
  difficulty: Difficulty;
  explanation: string | null;
  /** The normalised picture file name, or null. Whether that picture exists is checked by the caller. */
  imageFile: string | null;
  hash: string;
}

const CONTROL = /[\u0000-\u001f\u007f]/g;
const FORMULA_START = /^[=@]/;
const clean = (value: string | null | undefined): string => (value ?? '').replace(CONTROL, '').trim();

/** Two questions are the same when their type, wording, options and picture are the same, ignoring case and spacing. */
export function questionHash(type: string, text: string, optionTexts: readonly string[], imageFile: string | null): string {
  return createHash('sha256')
    .update([type, normalizeAnswer(text), ...optionTexts.map(normalizeAnswer), imageFile ?? ''].join('\u0001'))
    .digest('hex');
}

export function buildQuestion(input: QuestionInput): { ok: true; value: BuiltQuestion } | { ok: false; issues: QuestionIssue[] } {
  const issues: QuestionIssue[] = [];
  const problem = (field: string, issue: string): void => void issues.push({ field, issue });
  const text_ = (field: string, raw: string | null | undefined, max: number, required: boolean): string => {
    const value = clean(raw);
    if (!value) { if (required) problem(field, 'Required'); return ''; }
    if (value.length > max) problem(field, `At most ${max} characters`);
    else if (FORMULA_START.test(value)) problem(field, 'Must not start with = or @');
    return value;
  };

  const type = clean(input.type).toUpperCase().replace(/[\s-]+/g, '_');
  if (!(QUESTION_TYPES as readonly string[]).includes(type)) problem('type', 'Use MCQ, TRUE_FALSE or SHORT_ANSWER');
  const text = text_('text', input.text, 1000, true);

  // Options belong to multiple-choice questions only, and are lettered from A.
  const optionTexts = (input.options ?? []).map((o, i) => text_(`options.${i}`, o, 300, true));
  const options = optionTexts.map((t, i) => ({ key: OPTION_KEYS[i] ?? '', text: t }));
  if (type === 'MCQ') {
    if (optionTexts.length < 2) problem('options', 'A multiple-choice question needs at least two options');
    else if (optionTexts.length > OPTION_KEYS.length) problem('options', `At most ${OPTION_KEYS.length} options`);
    else if (new Set(optionTexts.map(normalizeAnswer)).size !== optionTexts.length) problem('options', 'Two options are the same');
  } else if (optionTexts.length > 0) {
    problem('options', 'Options are only for MCQ questions. Send options: null');
  }

  // The correct answer.
  let correctAnswer: string | string[] = '';
  const raw = input.correctAnswer;
  if (type === 'MCQ') {
    const key = (typeof raw === 'string' ? raw : '').trim().toUpperCase();
    if (!options.some((o) => o.key === key)) problem('correctAnswer', 'Must be the letter of one of the options');
    else correctAnswer = key;
  } else if (type === 'TRUE_FALSE') {
    const v = (typeof raw === 'string' ? raw : '').trim().toUpperCase();
    if (v === 'TRUE' || v === 'T') correctAnswer = 'TRUE';
    else if (v === 'FALSE' || v === 'F') correctAnswer = 'FALSE';
    else problem('correctAnswer', 'Use TRUE or FALSE');
  } else if (type === 'SHORT_ANSWER') {
    const list = typeof raw === 'string' ? raw.split('|') : [...raw];
    const accepted = [...new Set(list.map((a) => normalizeAnswer(clean(a))).filter(Boolean))];
    if (accepted.length === 0 || accepted.length > 10) problem('correctAnswer', 'Give 1 to 10 accepted answers');
    else if (accepted.some((a) => a.length > 100)) problem('correctAnswer', 'Each accepted answer can be at most 100 characters');
    else correctAnswer = accepted;
  }

  const marks = input.marks ?? 1;
  if (!Number.isFinite(marks) || marks < 0.5 || marks > 100 || Math.round(marks * 10) / 10 !== marks) {
    problem('marks', 'Use a number from 0.5 to 100, with at most one decimal');
  }

  const topic = text_('topic', input.topic, 60, false);
  const difficulty = (input.difficulty ?? 'MEDIUM').toUpperCase();
  if (!(DIFFICULTIES as readonly string[]).includes(difficulty)) problem('difficulty', 'Use EASY, MEDIUM or HARD');
  const explanation = text_('explanation', input.explanation, 500, false);

  let imageFile: string | null = null;
  if (input.imageFileName) {
    imageFile = normalizeImageFileName(input.imageFileName);
    if (!imageFile) problem('imageFileName', 'Use the picture\'s file name, like triangle.png');
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      type: type as QuestionType, text, options: type === 'MCQ' ? options : null, correctAnswer, marks,
      topic: topic || null, difficulty: difficulty as Difficulty, explanation: explanation || null, imageFile,
      hash: questionHash(type, text, optionTexts, imageFile),
    },
  };
}
