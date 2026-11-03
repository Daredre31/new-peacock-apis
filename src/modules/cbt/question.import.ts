import { createHash, createHmac, randomBytes } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { AppError } from '../../common/errors/AppError';
import { withTransaction } from '../../config/db';
import { recordSafely, type AuditPort } from '../audit/audit.port';
import type { KeyValueStore } from '../auth/keyValueStore';
import { DIFFICULTIES, EXAM_STATUS, MAX_QUESTIONS, OPTION_KEYS, QUESTION_TYPES, type Difficulty, type QuestionType } from './cbt.types';
import type { ExamRecord, examRepository } from './exam.repository';
import { normalizeAnswer } from './grading';
import type { PaperCache } from './paper.cache';
import type { NewQuestion, questionRepository } from './question.repository';

const MAX_ERRORS = 500;
const PREVIEW_ROWS = 20;
const TOKEN_TTL_SECONDS = 15 * 60;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MARKS = /^\d{1,3}(\.\d)?$/;
const FORMULA_START = /^[=@]/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

export const QUESTION_TEMPLATE_CSV = [
  'type,question,option_a,option_b,option_c,option_d,option_e,correct,marks,topic,difficulty,explanation',
  'MCQ,Which gas do plants absorb?,Oxygen,Carbon dioxide,Nitrogen,Helium,,B,1,Photosynthesis,EASY,Plants take in CO2',
  'TRUE_FALSE,The sun is a star.,,,,,,TRUE,1,Space,EASY,',
  'SHORT_ANSWER,Capital of Nigeria?,,,,,,Abuja|abuja,2,Geography,EASY,',
  '',
].join('\r\n');

const COLUMNS: Record<string, string> = {
  type: 'type', question: 'question', optiona: 'optionA', optionb: 'optionB', optionc: 'optionC', optiond: 'optionD', optione: 'optionE',
  correct: 'correct', marks: 'marks', topic: 'topic', difficulty: 'difficulty', explanation: 'explanation',
};
const REQUIRED = ['type', 'question', 'correct'];

interface Actor { id: string }
interface Context { ip: string; requestId: string }
interface RowError { row: number; field: string; issue: string }
interface StoredImport { actorId: string; examId: string; fileName: string; questions: NewQuestion[] }

const invalidFile = (issue: string): AppError => new AppError('IMPORT_INVALID', { details: [{ field: 'file', issue }] });
const clean = (v: string | undefined): string => (v ?? '').replace(CONTROL, '').trim();
const letterOf = (i: number): string => OPTION_KEYS[i] ?? '';

export function createQuestionImportService(deps: {
  store: KeyValueStore; secret: string;
  exams: Pick<typeof examRepository, 'findById' | 'setQuestionStats'>;
  questions: Pick<typeof questionRepository, 'replaceAll'>;
  paper: PaperCache; audit: AuditPort;
}) {
  const keyOf = (token: string): string => `import:questions:${createHmac('sha256', deps.secret).update(`import:${token}`).digest('hex')}`;

  async function editableExam(actor: Actor, examId: string): Promise<ExamRecord> {
    const exam = await deps.exams.findById(examId);
    if (!exam || exam.teacherId !== actor.id) throw new AppError('NOT_FOUND');
    if (exam.status !== EXAM_STATUS.DRAFT && exam.status !== EXAM_STATUS.REJECTED) {
      throw new AppError('CONFLICT', { message: 'Only a draft or a rejected exam can have its questions changed' });
    }
    return exam;
  }

  return {
    async upload(actor: Actor, examId: string, fileName: string, buffer: Buffer) {
      await editableExam(actor, examId);

      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
      catch { throw invalidFile('The file is not valid UTF-8 text. Save it as "CSV UTF-8"'); }

      let records: string[][];
      try { records = parse(text, { skip_empty_lines: true, trim: true, relax_column_count: false, max_record_size: 10_000 }) as string[][]; }
      catch { throw invalidFile('The file is not a valid CSV. Check that every row has the same number of columns'); }

      const [first, ...rows] = records;
      if (!first || rows.length === 0) throw invalidFile('The file has no questions');
      if (rows.length > MAX_QUESTIONS) throw invalidFile(`An exam can have at most ${MAX_QUESTIONS} questions`);

      const seen = new Set<string>();
      const header = first.map((cell) => {
        const name = COLUMNS[cell.toLowerCase().replace(/[^a-z]/g, '')];
        if (!name) throw invalidFile(`Unknown column "${clean(cell).slice(0, 40)}". Download the template`);
        if (seen.has(name)) throw invalidFile(`Column "${name}" appears twice`);
        seen.add(name);
        return name;
      });
      for (const column of REQUIRED) if (!seen.has(column)) throw invalidFile(`Missing column "${column}"`);

      const errors: RowError[] = [];
      const questions: NewQuestion[] = [];
      const hashes = new Map<string, number>();

      rows.forEach((cells, index) => {
        const row = index + 2;
        const before = errors.length;
        const get = (field: string): string => clean(cells[header.indexOf(field)]);
        const problem = (field: string, issue: string): void => void errors.push({ row, field, issue });
        const text_ = (field: string, max: number, required: boolean): string => {
          const value = get(field);
          if (!value) { if (required) problem(field, 'Required'); return ''; }
          if (value.length > max) problem(field, `At most ${max} characters`);
          else if (FORMULA_START.test(value)) problem(field, 'Must not start with = or @');
          return value;
        };

        const type = get('type').toUpperCase().replace(/[\s-]+/g, '_');
        if (!(QUESTION_TYPES as readonly string[]).includes(type)) problem('type', 'Use MCQ, TRUE_FALSE or SHORT_ANSWER');
        const questionText = text_('question', 1000, true);

        // Options: MCQ only, from A with no gaps.
        const options: { key: string; text: string }[] = [];
        let gap = false;
        OPTION_KEYS.forEach((key, i) => {
          const value = text_(`option${key}`, 300, false);
          if (value) { if (gap) problem(`option${key}`, 'Options must be filled in order, without gaps'); options.push({ key: letterOf(i), text: value }); }
          else gap = true;
        });
        if (type === 'MCQ') {
          if (options.length < 2) problem('optionA', 'A multiple-choice question needs at least two options');
          if (new Set(options.map((o) => normalizeAnswer(o.text))).size !== options.length) problem('optionA', 'Two options are the same');
        } else if (options.length > 0) problem('optionA', 'Options are only for MCQ questions');

        // The correct answer.
        let correctAnswer: string | string[] = '';
        const rawCorrect = get('correct');
        if (type === 'MCQ') {
          const key = rawCorrect.toUpperCase();
          if (!options.some((o) => o.key === key)) problem('correct', 'Must be the letter of one of the options');
          else correctAnswer = key;
        } else if (type === 'TRUE_FALSE') {
          const v = rawCorrect.toUpperCase();
          if (v === 'TRUE' || v === 'T') correctAnswer = 'TRUE';
          else if (v === 'FALSE' || v === 'F') correctAnswer = 'FALSE';
          else problem('correct', 'Use TRUE or FALSE');
        } else if (type === 'SHORT_ANSWER') {
          const accepted = [...new Set(rawCorrect.split('|').map((a) => normalizeAnswer(clean(a))).filter(Boolean))];
          if (accepted.length === 0 || accepted.length > 10) problem('correct', 'Give 1 to 10 accepted answers, separated by |');
          else if (accepted.some((a) => a.length > 100)) problem('correct', 'Each accepted answer can be at most 100 characters');
          else correctAnswer = accepted;
        }

        const rawMarks = get('marks');
        let marks = 1;
        if (rawMarks) {
          marks = Number(rawMarks);
          if (!MARKS.test(rawMarks) || marks < 0.5 || marks > 100) { problem('marks', 'Use a number from 0.5 to 100, with at most one decimal'); marks = 1; }
        }

        const topic = text_('topic', 60, false);
        const rawDifficulty = get('difficulty').toUpperCase();
        let difficulty: Difficulty = 'MEDIUM';
        if (rawDifficulty) {
          if ((DIFFICULTIES as readonly string[]).includes(rawDifficulty)) difficulty = rawDifficulty as Difficulty;
          else problem('difficulty', 'Use EASY, MEDIUM or HARD');
        }
        const explanation = text_('explanation', 500, false);

        const hash = createHash('sha256').update([type, normalizeAnswer(questionText), ...options.map((o) => normalizeAnswer(o.text))].join('\u0001')).digest('hex');
        if (errors.length === before) {
          if (hashes.has(hash)) problem('question', `Same question as row ${hashes.get(hash)}`);
          else {
            hashes.set(hash, row);
            questions.push({
              type: type as QuestionType, text: questionText, options: type === 'MCQ' ? options : null, correctAnswer, marks,
              topic: topic || null, difficulty, explanation: explanation || null, hash,
            });
          }
        }
      });

      const clear = errors.length === 0;
      let importToken: string | null = null;
      if (clear) {
        importToken = randomBytes(32).toString('base64url');
        await deps.store.setMany([{ key: keyOf(importToken), value: JSON.stringify({ actorId: actor.id, examId, fileName: fileName.slice(0, 200), questions }), ttlSeconds: TOKEN_TTL_SECONDS }]);
      }

      return {
        rowCount: rows.length, validCount: clear ? questions.length : rows.length - new Set(errors.map((e) => e.row)).size,
        errors: errors.slice(0, MAX_ERRORS), truncated: errors.length > MAX_ERRORS,
        totalMarks: clear ? Math.round(questions.reduce((s, q) => s + q.marks, 0) * 10) / 10 : null,
        byType: clear ? Object.fromEntries(QUESTION_TYPES.map((t) => [t, questions.filter((q) => q.type === t).length])) : null,
        preview: questions.slice(0, PREVIEW_ROWS).map((q) => ({ type: q.type, text: q.text.slice(0, 120), marks: q.marks })),
        importToken,
      };
    },

    async confirm(actor: Actor, examId: string, token: string, ctx: Context) {
      if (!TOKEN.test(token)) throw new AppError('IMPORT_TOKEN_EXPIRED');
      await editableExam(actor, examId);

      const raw = await deps.store.getAndDelete(keyOf(token)); // works once
let stored: StoredImport | null = null;
try { stored = raw ? (JSON.parse(raw) as StoredImport) : null; } catch { stored = null; }
if (!stored || stored.actorId !== actor.id || stored.examId !== examId) throw new AppError('IMPORT_TOKEN_EXPIRED');
const upload = stored;
      // The old questions, the new ones and the exam's totals change together or not at all.
      const result = await withTransaction(async (session) => {
        const saved = await deps.questions.replaceAll(examId, actor.id, upload.fileName, upload.questions, session);
        if (!(await deps.exams.setQuestionStats(examId, saved.count, saved.maxScore, session))) {
          throw new AppError('CONFLICT', { message: 'This exam was submitted while you were uploading' });
        }
        return saved;
      });

      await deps.paper.invalidate(examId);
      await recordSafely(deps.audit, {
        action: 'EXAM_QUESTIONS_IMPORTED', actorId: actor.id, entityType: 'exam', entityId: examId, ip: ctx.ip, requestId: ctx.requestId,
        metadata: { questions: result.count, maxScore: result.maxScore, fileName: upload.fileName },
      });
      return { questions: result.count, maxScore: result.maxScore };
    },
  };
}

export type QuestionImportService = ReturnType<typeof createQuestionImportService>;