import { createHmac, randomBytes } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { AppError } from '../../common/errors/AppError';
import { withTransaction } from '../../config/db';
import { recordSafely, type AuditPort } from '../audit/audit.port';
import type { KeyValueStore } from '../auth/keyValueStore';
import { poolIssue } from './pool';
import { EXAM_STATUS, MAX_QUESTIONS, OPTION_KEYS, QUESTION_TYPES } from './cbt.types';
import type { ExamRecord, examRepository } from './exam.repository';
import type { PaperCache } from './paper.cache';
import type { ImageRecord } from './question.image.repository';
import type { NewQuestion, questionRepository } from './question.repository';
import { buildQuestion, type BuiltQuestion, type QuestionInput, type QuestionIssue } from './question.rules';

const MAX_ERRORS = 500;
const PREVIEW_ROWS = 20;
/** An uploaded file stays as an editable draft this long. */
const BATCH_TTL_SECONDS = 24 * 60 * 60;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MARKS = /^\d{1,3}(\.\d)?$/;
const CONTROL = /[\u0000-\u001f\u007f]/g;

export const QUESTION_TEMPLATE_CSV = [
  'type,question,option_a,option_b,option_c,option_d,option_e,correct,marks,topic,difficulty,explanation,image',
  'MCQ,Which gas do plants absorb?,Oxygen,Carbon dioxide,Nitrogen,Helium,,B,1,Photosynthesis,EASY,Plants take in CO2,',
  'TRUE_FALSE,The sun is a star.,,,,,,TRUE,1,Space,EASY,,',
  'SHORT_ANSWER,Capital of Nigeria?,,,,,,Abuja|abuja,2,Geography,EASY,,',
  'SHORT_ANSWER,What is the area of the triangle shown?,,,,,,24|24 cm2,2,Geometry,MEDIUM,,triangle.png',
  '',
].join('\r\n');

const COLUMNS: Record<string, string> = {
  type: 'type', question: 'question', optiona: 'optionA', optionb: 'optionB', optionc: 'optionC', optiond: 'optionD', optione: 'optionE',
  correct: 'correct', marks: 'marks', topic: 'topic', difficulty: 'difficulty', explanation: 'explanation', image: 'image',
};
const REQUIRED = ['type', 'question', 'correct'];

interface Actor { id: string }
interface Context { ip: string; requestId: string }
interface RowError { row: number; field: string; issue: string }

/** One question in a draft. `row` is its line in the uploaded file, or null for one added by hand. */
interface DraftRow { tempId: string; row: number | null; input: QuestionInput }
interface StoredBatch { actorId: string; examId: string; fileName: string; createdAt: string; expiresAt: string; rows: DraftRow[] }

const invalidFile = (issue: string): AppError => new AppError('IMPORT_INVALID', { details: [{ field: 'file', issue }] });
const clean = (v: string | undefined): string => (v ?? '').replace(CONTROL, '').trim();
const newTempId = (): string => randomBytes(6).toString('hex');
const round1 = (n: number): number => Math.round(n * 10) / 10;

/** The same rules apply to an uploaded row and a hand-written one. This puts a message in terms the teacher will recognise. */
const plain = (issue: QuestionIssue): QuestionIssue => {
  if (/^options\.\d+$/.test(issue.field) && issue.issue === 'Required') return { field: issue.field, issue: 'This option is empty. Fill options in order from A, without gaps' };
  return issue;
};

/** Spreadsheet column names for the errors list that the upload has always returned. */
const csvField = (field: string): string => {
  if (field === 'text') return 'question';
  if (field === 'correctAnswer') return 'correct';
  if (field === 'imageFileName') return 'image';
  const m = /^options\.(\d+)$/.exec(field);
  if (m) return `option${OPTION_KEYS[Number(m[1])] ?? ''}`;
  return field === 'options' ? 'optionA' : field;
};
const csvIssue = (issue: QuestionIssue): string => {
  if (issue.field === 'options' && issue.issue.startsWith('Options are only for MCQ')) return 'Options are only for MCQ questions';
  if (issue.field === 'correctAnswer' && issue.issue === 'Give 1 to 10 accepted answers') return 'Give 1 to 10 accepted answers, separated by |';
  return issue.issue;
};

interface Evaluated { draft: DraftRow; label: string; errors: QuestionIssue[]; warnings: QuestionIssue[]; built: BuiltQuestion | null }

/** Checks every draft question with the shared question rules, and flags a question that repeats an earlier one. */
function evaluate(rows: readonly DraftRow[], library: Map<string, ImageRecord>): Evaluated[] {
  const firstSeen = new Map<string, string>();
  return rows.map((draft, index) => {
    const label = draft.row !== null ? `row ${draft.row}` : `question ${index + 1}`;
    const result = buildQuestion(draft.input);
    const errors: QuestionIssue[] = [];
    const warnings: QuestionIssue[] = [];
    let built: BuiltQuestion | null = null;
    if (!result.ok) {
      errors.push(...result.issues.map(plain));
    } else {
      built = result.value;
      // A picture that has not been uploaded is a warning, not an error: it can still be uploaded before confirming.
      if (built.imageFile && !library.has(built.imageFile)) {
        warnings.push({ field: 'imageFileName', issue: `No picture named "${built.imageFile}" has been uploaded to this exam yet. Upload it before confirming, or the question will have no picture` });
      }
      const seen = firstSeen.get(built.hash);
      if (seen) { errors.push({ field: 'text', issue: `Same question as ${seen}` }); built = null; }
      else firstSeen.set(built.hash, label);
    }
    return { draft, label, errors, warnings, built };
  });
}

export function createQuestionImportService(deps: {
  store: KeyValueStore; secret: string;
  exams: Pick<typeof examRepository, 'findById' | 'setQuestionStats'>;
  questions: Pick<typeof questionRepository, 'replaceAll'>;
  /** The exam's uploaded pictures by file name, so an image column can be matched. */
  pictures: { byName(examId: string): Promise<Map<string, ImageRecord>> };
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

  /** The teacher's own draft, or "expired": a wrong, old or someone else's id looks the same as one that ran out. */
  async function load(actor: Actor, examId: string, batchId: string): Promise<StoredBatch> {
    if (!TOKEN.test(batchId)) throw new AppError('IMPORT_TOKEN_EXPIRED');
    const raw = await deps.store.get(keyOf(batchId));
    let stored: StoredBatch | null = null;
    try { stored = raw ? (JSON.parse(raw) as StoredBatch) : null; } catch { stored = null; }
    if (!stored || stored.actorId !== actor.id || stored.examId !== examId || !Array.isArray(stored.rows)) throw new AppError('IMPORT_TOKEN_EXPIRED');
    return stored;
  }

  /** Writes the draft back, keeping its original 24 hours: editing does not extend it. */
  async function save(batchId: string, batch: StoredBatch): Promise<void> {
    const seconds = Math.floor((Date.parse(batch.expiresAt) - Date.now()) / 1000);
    if (seconds < 1) throw new AppError('IMPORT_TOKEN_EXPIRED');
    await deps.store.setMany([{ key: keyOf(batchId), value: JSON.stringify(batch), ttlSeconds: seconds }]);
  }

  /** The whole draft as the teacher sees it: every question with its own valid flag and errors. */
  async function describe(exam: ExamRecord, batch: StoredBatch, batchId: string) {
    const library = await deps.pictures.byName(exam.id);
    const evaluated = evaluate(batch.rows, library);
    const valid = evaluated.filter((e) => e.errors.length === 0 && e.built !== null);
    const built = valid.flatMap((e) => (e.built ? [e.built] : []));
    // Once every question is fine on its own, check the set works with the exam's "questions per student" setting.
    const poolProblem = valid.length === evaluated.length ? poolIssue(exam.settings.questionsPerStudent, built.length, built.map((q) => q.marks)) : null;
    const clear = evaluated.length > 0 && valid.length === evaluated.length && poolProblem === null;

    const legacyErrors: RowError[] = evaluated.flatMap((e) => e.errors.map((i) => ({ row: e.draft.row ?? 0, field: csvField(i.field), issue: csvIssue(i) })));
    const legacyWarnings: RowError[] = evaluated.flatMap((e) => e.warnings.map((i) => ({ row: e.draft.row ?? 0, field: csvField(i.field), issue: i.issue })));
    const errors = [...(poolProblem ? [{ row: 0, field: poolProblem.field, issue: poolProblem.issue }] : []), ...legacyErrors];

    return {
      batchId, examId: exam.id, fileName: batch.fileName, expiresAt: batch.expiresAt,
      rowCount: evaluated.length, validCount: valid.length,
      warnings: legacyWarnings.slice(0, MAX_ERRORS),
      errors: errors.slice(0, MAX_ERRORS), truncated: errors.length > MAX_ERRORS,
      totalMarks: clear ? round1(built.reduce((sum, q) => sum + q.marks, 0)) : null,
      byType: clear ? Object.fromEntries(QUESTION_TYPES.map((t) => [t, built.filter((q) => q.type === t).length])) : null,
      preview: built.slice(0, PREVIEW_ROWS).map((q) => ({ type: q.type, text: q.text.slice(0, 120), marks: q.marks })),
      importToken: clear ? batchId : null,
      rows: evaluated.map((e) => ({
        tempId: e.draft.tempId, row: e.draft.row, valid: e.errors.length === 0, errors: e.errors, warnings: e.warnings,
        question: {
          type: e.draft.input.type, text: e.draft.input.text, options: e.draft.input.options ? [...e.draft.input.options] : null,
          correctAnswer: typeof e.draft.input.correctAnswer === 'string' ? e.draft.input.correctAnswer : [...e.draft.input.correctAnswer],
          marks: e.draft.input.marks ?? 1, topic: e.draft.input.topic ?? null, difficulty: e.draft.input.difficulty ?? 'MEDIUM',
          explanation: e.draft.input.explanation ?? null, imageFileName: e.draft.input.imageFileName ?? null,
        },
      })),
      problems: poolProblem ? [poolProblem] : [],
    };
  }

  return {
    /** Reads the file into an editable draft. Nothing is written to the exam yet. */
    async upload(actor: Actor, examId: string, fileName: string, buffer: Buffer) {
      const exam = await editableExam(actor, examId);

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

      const draftRows: DraftRow[] = rows.map((cells, index) => {
        const get = (field: string): string => clean(cells[header.indexOf(field)]);
        // Options run from A with no gaps. A gap is kept as an empty option, which the shared rules report.
        const optionCells = OPTION_KEYS.map((key) => get(`option${key}`));
        const last = optionCells.reduce((at, value, i) => (value ? i : at), -1);
        const rawMarks = get('marks');
        return {
          tempId: newTempId(), row: index + 2,
          input: {
            type: get('type'), text: get('question'), options: last >= 0 ? optionCells.slice(0, last + 1) : null,
            correctAnswer: get('correct'),
            // A value that is not a plain number is passed as -1, which the shared rules refuse with the usual marks message.
            marks: rawMarks === '' ? undefined : (MARKS.test(rawMarks) ? Number(rawMarks) : -1),
            topic: get('topic') || null, difficulty: get('difficulty') || undefined,
            explanation: get('explanation') || null, imageFileName: get('image') || null,
          },
        };
      });

      const batchId = randomBytes(32).toString('base64url');
      const now = Date.now();
      const batch: StoredBatch = {
        actorId: actor.id, examId, fileName: fileName.slice(0, 200), createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + BATCH_TTL_SECONDS * 1000).toISOString(), rows: draftRows,
      };
      await save(batchId, batch);
      return describe(exam, batch, batchId);
    },

    async get(actor: Actor, examId: string, batchId: string) {
      const exam = await editableExam(actor, examId);
      return describe(exam, await load(actor, examId, batchId), batchId);
    },

    /** Adds a question written by hand to the draft. */
    async addQuestion(actor: Actor, examId: string, batchId: string, input: QuestionInput) {
      const exam = await editableExam(actor, examId);
      const batch = await load(actor, examId, batchId);
      if (batch.rows.length >= MAX_QUESTIONS) throw new AppError('CONFLICT', { details: [{ field: 'text', issue: `An exam can have at most ${MAX_QUESTIONS} questions` }] });
      batch.rows.push({ tempId: newTempId(), row: null, input });
      await save(batchId, batch);
      return describe(exam, batch, batchId);
    },

    /** Changes any of a draft question's fields. Only what is sent changes. The question is re-checked, not refused: it just shows its errors. */
    async updateQuestion(actor: Actor, examId: string, batchId: string, tempId: string, patch: Partial<QuestionInput>) {
      const exam = await editableExam(actor, examId);
      const batch = await load(actor, examId, batchId);
      const index = batch.rows.findIndex((r) => r.tempId === tempId);
      const current = batch.rows[index];
      if (index < 0 || !current) throw new AppError('NOT_FOUND');

      const changes = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<QuestionInput>;
      if (Object.keys(changes).length === 0) throw new AppError('VALIDATION_ERROR', { details: [{ field: 'body', issue: 'Nothing to update' }] });
      const merged: QuestionInput = { ...current.input, ...changes };
      // Moving to a type without options drops them, so a teacher need not send options: null as well.
      if (changes.type !== undefined && changes.options === undefined && String(merged.type).trim().toUpperCase().replace(/[\s-]+/g, '_') !== 'MCQ') merged.options = null;
      batch.rows[index] = { ...current, input: merged };
      await save(batchId, batch);
      return describe(exam, batch, batchId);
    },

    async removeQuestion(actor: Actor, examId: string, batchId: string, tempId: string) {
      const exam = await editableExam(actor, examId);
      const batch = await load(actor, examId, batchId);
      const rows = batch.rows.filter((r) => r.tempId !== tempId);
      if (rows.length === batch.rows.length) throw new AppError('NOT_FOUND');
      batch.rows = rows;
      await save(batchId, batch);
      return describe(exam, batch, batchId);
    },

    /** Throws the draft away. Nothing was ever written to the exam. */
    async discard(actor: Actor, examId: string, batchId: string): Promise<void> {
      await editableExam(actor, examId);
      await load(actor, examId, batchId);
      await deps.store.delete(keyOf(batchId));
    },

    /** Saves the draft as the exam's questions, in one transaction. Refused, with the list of problems, if any question is still invalid. */
    async confirm(actor: Actor, examId: string, batchId: string, ctx: Context) {
      const exam = await editableExam(actor, examId);
      const batch = await load(actor, examId, batchId);
      const shown = await describe(exam, batch, batchId);

      if (shown.rowCount === 0) throw invalidFile('The draft has no questions');
      if (shown.importToken === null) {
        const details = [
          ...shown.problems.map((p) => ({ field: p.field, issue: p.issue })),
          ...shown.rows.flatMap((r, i) => r.errors.map((e) => ({ field: `${r.row !== null ? `row ${r.row}` : `question ${i + 1}`} (${r.tempId}): ${e.field}`.slice(0, 100), issue: e.issue }))),
        ].slice(0, 50);
        throw new AppError('IMPORT_INVALID', { message: `${shown.rowCount - shown.validCount || shown.problems.length} problem(s) must be fixed before this can be saved`, details });
      }

      const claimed = await deps.store.getAndDelete(keyOf(batchId)); // works once
      if (!claimed) throw new AppError('IMPORT_TOKEN_EXPIRED');

      try {
        // Pictures are matched by file name at this moment, so one uploaded after the preview is picked up.
        const library = await deps.pictures.byName(examId);
        const questions: NewQuestion[] = evaluate(batch.rows, library).flatMap((e) => {
          const q = e.built;
          if (!q) return [];
          const picture = q.imageFile ? library.get(q.imageFile) : undefined;
          return [picture ? { ...q, imageFileName: picture.fileName, imageUrl: picture.url, imageWidth: picture.width, imageHeight: picture.height } : q];
        });
        // The old questions, the new ones and the exam's totals change together or not at all.
        const result = await withTransaction(async (session) => {
          const saved = await deps.questions.replaceAll(examId, actor.id, batch.fileName, questions, session);
          if (!(await deps.exams.setQuestionStats(examId, saved.count, saved.maxScore, session))) {
            throw new AppError('CONFLICT', { message: 'This exam was submitted while you were uploading' });
          }
          return saved;
        });

        await deps.paper.invalidate(examId);
        await recordSafely(deps.audit, {
          action: 'EXAM_QUESTIONS_IMPORTED', actorId: actor.id, entityType: 'exam', entityId: examId, ip: ctx.ip, requestId: ctx.requestId,
          metadata: { questions: result.count, maxScore: result.maxScore, fileName: batch.fileName, withPictures: questions.filter((q) => q.imageUrl).length },
        });
        return { questions: result.count, maxScore: result.maxScore };
      } catch (err) {
        // The save failed, so give the teacher their draft back rather than lose their edits.
        try { await save(batchId, batch); } catch { /* the draft had already run out */ }
        throw err;
      }
    },
  };
}

export type QuestionImportService = ReturnType<typeof createQuestionImportService>;
