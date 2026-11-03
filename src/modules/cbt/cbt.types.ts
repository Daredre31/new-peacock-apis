export const EXAM_TYPES = ['CLASS_TEST', 'TERM_EXAM'] as const;
export type ExamType = (typeof EXAM_TYPES)[number];

export const EXAM_STATUS = { DRAFT: 'DRAFT', PENDING_APPROVAL: 'PENDING_APPROVAL', REJECTED: 'REJECTED', PUBLISHED: 'PUBLISHED' } as const;
export type ExamStatus = (typeof EXAM_STATUS)[keyof typeof EXAM_STATUS];

export const QUESTION_TYPES = ['MCQ', 'TRUE_FALSE', 'SHORT_ANSWER'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];
export const DIFFICULTIES = ['EASY', 'MEDIUM', 'HARD'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];
export const OPTION_KEYS = ['A', 'B', 'C', 'D', 'E'] as const;

export interface ExamSettings {
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  /** IMMEDIATE: a student sees their score right after submitting. MANUAL: after the teacher releases results. */
  resultRelease: 'IMMEDIATE' | 'MANUAL';
  /** Show the answer review. Only ever after results are released, which needs the window to have closed. */
  showAnswers: boolean;
  passMarkPercent: number;
  /** A score component (for example EXAM) to copy each student's scaled score into when results are released. */
  scoreComponent: string | null;
}

export const DEFAULT_SETTINGS: ExamSettings = {
  shuffleQuestions: true, shuffleOptions: true, resultRelease: 'MANUAL', showAnswers: false, passMarkPercent: 50, scoreComponent: null,
};

/** A final save or submit is still accepted this long after the clock ends, to allow for network lag. */
export const GRACE_MS = 5_000;
export const MAX_QUESTIONS = 200;