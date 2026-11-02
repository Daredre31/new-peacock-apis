import { createHmac, randomBytes } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { AppError } from '../../common/errors/AppError';
import { gradeFor, type AssessmentConfig } from '../settings/assessment';
import type { Role } from '../../config/constants';
import type { KeyValueStore } from '../auth/keyValueStore';
import type { studentRepository } from '../users/student.repository';
import { totalOf } from './results.engine';
import type { scoreRepository } from './score.repository';
import type { GridQuery, ScoresService } from './scores.service';

const MAX_ROWS = 1000;
const MAX_ERRORS = 500;
const PREVIEW_ROWS = 200;
const TOKEN_TTL_SECONDS = 15 * 60;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SCORE_VALUE = /^\d{1,3}(\.\d)?$/;

interface Actor { id: string; role: Role }
interface Context { ip: string; requestId: string }
interface RowError { row: number; field: string; issue: string }
interface Entry { studentId: string; components: Record<string, number> }

const invalidFile = (issue: string): AppError => new AppError('IMPORT_INVALID', { details: [{ field: 'file', issue }] });
const clean = (v: string | undefined): string => (v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
const normal = (v: string): string => v.toLowerCase().replace(/[^a-z0-9]/g, '');

export function createScoresImportService(deps: {
  store: KeyValueStore;
  secret: string;
  scoresService: Pick<ScoresService, 'teacherContext' | 'saveGrid'>;
  scores: Pick<typeof scoreRepository, 'forGrid'>;
  settings: { getAssessment(): Promise<AssessmentConfig> };
  students: Pick<typeof studentRepository, 'userIdsByAdmissionNos' | 'profileMap'>;
}) {
  const keyOf = (token: string): string => `import:scores:${createHmac('sha256', deps.secret).update(`import:${token}`).digest('hex')}`;

  return {
    async upload(actor: Actor, q: GridQuery, buffer: Buffer) {
      const base = await deps.scoresService.teacherContext(actor, q);
      const config = await deps.settings.getAssessment();

      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
      catch { throw invalidFile('The file is not valid UTF-8 text. Save it as "CSV UTF-8"'); }

      let records: string[][];
      try { records = parse(text, { skip_empty_lines: true, trim: true, relax_column_count: false, max_record_size: 5000 }) as string[][]; }
      catch { throw invalidFile('The file is not a valid CSV. Check that every row has the same number of columns'); }

      const [first, ...rows] = records;
      if (!first || rows.length === 0) throw invalidFile('The file has no data rows');
      if (rows.length > MAX_ROWS) throw invalidFile(`The file has more than ${MAX_ROWS} rows`);

      const byKey = new Map(config.components.map((c) => [normal(c.key), c]));
      const columns = first.map((cell) => {
        const n = normal(cell);
        if (n === 'admissionno') return { kind: 'admission' as const };
        const component = byKey.get(n);
        if (!component) throw invalidFile(`Unknown column "${clean(cell).slice(0, 40)}". Use admissionNo and ${config.components.map((c) => c.key).join(', ')}`);
        return { kind: 'component' as const, component };
      });
      const admissionColumn = columns.findIndex((c) => c.kind === 'admission');
      if (admissionColumn < 0) throw invalidFile('Missing column "admissionNo"');
      if (!columns.some((c) => c.kind === 'component')) throw invalidFile('Include at least one score column');

      const nos = rows.map((cells) => clean(cells[admissionColumn]).toUpperCase()).filter(Boolean);
      const [idByNo, existingDocs] = await Promise.all([deps.students.userIdsByAdmissionNos(nos), deps.scores.forGrid(q.classArmId, q.subjectId, q.termId)]);
      const enrolled = new Set(base.studentIds);
      const existing = new Map(existingDocs.map((d) => [d.studentId, d]));

      const errors: RowError[] = [];
      const entries: Entry[] = [];
      const seen = new Map<string, number>();

      rows.forEach((cells, index) => {
        const row = index + 2;
        const before = errors.length;
        const no = clean(cells[admissionColumn]).toUpperCase();
        const studentId = idByNo.get(no);

        if (!no) errors.push({ row, field: 'admissionNo', issue: 'Required' });
        else if (!studentId || !enrolled.has(studentId)) errors.push({ row, field: 'admissionNo', issue: 'No such student in this class' });
        else if (seen.has(studentId)) errors.push({ row, field: 'admissionNo', issue: `Same as row ${seen.get(studentId)}` });
        else seen.set(studentId, row);

        const components: Record<string, number> = {};
        columns.forEach((col, i) => {
          if (col.kind !== 'component') return;
          const raw = clean(cells[i]);
          if (!raw) return;
          const value = Number(raw);
          if (!SCORE_VALUE.test(raw)) errors.push({ row, field: col.component.key, issue: 'Not a valid score' });
          else if (value > col.component.max) errors.push({ row, field: col.component.key, issue: `Must be at most ${col.component.max}` });
          else components[col.component.key] = value;
        });
        if (errors.length === before && Object.keys(components).length === 0) errors.push({ row, field: 'row', issue: 'No scores in this row' });
        if (errors.length === before && studentId) entries.push({ studentId, components });
      });

      const clear = errors.length === 0;
      const profiles = await deps.students.profileMap(entries.map((e) => e.studentId));
      const preview = entries.slice(0, PREVIEW_ROWS).map((e) => {
        const merged = { ...(existing.get(e.studentId)?.components ?? {}), ...e.components };
        const { total, complete } = totalOf(merged, config);
        return {
          admissionNo: profiles.get(e.studentId)?.admissionNo ?? '', studentName: profiles.get(e.studentId)?.name ?? '',
          components: merged, total, grade: complete ? gradeFor(total, config.bands).grade : null,
        };
      });

      let importToken: string | null = null;
      if (clear) {
        importToken = randomBytes(32).toString('base64url');
        await deps.store.setMany([{ key: keyOf(importToken), value: JSON.stringify({ actorId: actor.id, ...q, entries }), ttlSeconds: TOKEN_TTL_SECONDS }]);
      }
      return {
        rowCount: rows.length, validCount: clear ? entries.length : rows.length - new Set(errors.map((e) => e.row)).size,
        errors: errors.slice(0, MAX_ERRORS), truncated: errors.length > MAX_ERRORS, preview, importToken,
      };
    },

    async confirm(actor: Actor, token: string, ctx: Context) {
      if (!TOKEN.test(token)) throw new AppError('IMPORT_TOKEN_EXPIRED');
      const raw = await deps.store.getAndDelete(keyOf(token)); // works once
      let stored: (GridQuery & { actorId: string; entries: Entry[] }) | null = null;
      try { stored = raw ? (JSON.parse(raw) as GridQuery & { actorId: string; entries: Entry[] }) : null; } catch { stored = null; }
      if (!stored || stored.actorId !== actor.id) throw new AppError('IMPORT_TOKEN_EXPIRED');

      return deps.scoresService.saveGrid(actor, { classArmId: stored.classArmId, subjectId: stored.subjectId, termId: stored.termId, entries: stored.entries }, ctx);
    },
  };
}

export type ScoresImportService = ReturnType<typeof createScoresImportService>;