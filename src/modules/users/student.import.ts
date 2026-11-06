import { createHmac, randomBytes } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { AppError, isAppError, type ErrorDetail } from '../../common/errors/AppError';
import { normalizeEmail, normalizePhone } from '../../common/utils/identifier';
import { logger } from '../../common/utils/logger';
import type { structureRepository } from '../academics/structure.repository';
import { recordSafely, type AuditPort } from '../audit/audit.port';
import type { KeyValueStore } from '../auth/keyValueStore';
import { GENDERS, type Gender } from './staff.model';
import type { StudentService } from './student.service';
import type { userRepository } from './user.repository';

const MAX_ROWS = 1000;
const MAX_REPORTED_ERRORS = 500;
const TOKEN_TTL_SECONDS = 15 * 60;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const COLUMNS: Record<string, string> = {
  firstname: 'firstName', middlename: 'middleName', lastname: 'lastName', gender: 'gender', dateofbirth: 'dateOfBirth', address: 'address',
  email: 'email', phone: 'phone', classname: 'className', armname: 'armName',
};
const REQUIRED = ['firstName', 'lastName'];
// Names, addresses and class names must not start with a spreadsheet formula character.
const FORMULA_START = /^[=+\-@\t\r]/;

interface ImportRow {
  row: number;
  firstName: string;
  middleName?: string;
  lastName: string;
  gender?: Gender;
  dateOfBirth?: string;
  address?: string;
  email?: string;
  phone?: string;
  classArmId?: string;
}
interface RowError { row: number; field: string; issue: string }
interface Actor { id: string }
interface Context { ip: string; requestId: string }

const invalidFile = (issue: string): AppError =>
  new AppError('IMPORT_INVALID', { details: [{ field: 'file', issue } satisfies ErrorDetail] });

const clean = (value: string | undefined): string => (value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();

export function createStudentImportService(deps: {
  store: KeyValueStore;
  secret: string;
  students: Pick<StudentService, 'create'>;
  users: Pick<typeof userRepository, 'findExistingContacts'>;
  structure: Pick<typeof structureRepository, 'listClasses' | 'listArms'>;
  audit: AuditPort;
}) {
  const { store, students, users, structure, audit } = deps;
  const keyOf = (token: string): string =>
    `import:students:${createHmac('sha256', deps.secret).update(`import:${token}`).digest('hex')}`;

  function readTable(buffer: Buffer): { header: string[]; rows: string[][] } {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      throw invalidFile('The file is not valid UTF-8 text. Save it as "CSV UTF-8"');
    }

    let records: string[][];
    try {
      records = parse(text, { skip_empty_lines: true, trim: true, relax_column_count: false, max_record_size: 10_000 }) as string[][];
    } catch {
      throw invalidFile('The file is not a valid CSV. Check that every row has the same number of columns');
    }

    const [first, ...rows] = records;
    if (!first || rows.length === 0) throw invalidFile('The file has no data rows');
    if (rows.length > MAX_ROWS) throw invalidFile(`The file has more than ${MAX_ROWS} rows`);

    const seen = new Set<string>();
    const header = first.map((cell) => {
      const canonical = COLUMNS[cell.toLowerCase().replace(/[^a-z]/g, '')];
      if (!canonical) throw invalidFile(`Unknown column "${clean(cell).slice(0, 40)}"`);
      if (seen.has(canonical)) throw invalidFile(`Column "${canonical}" appears twice`);
      seen.add(canonical);
      return canonical;
    });
    for (const column of REQUIRED) if (!seen.has(column)) throw invalidFile(`Missing column "${column}"`);
    return { header, rows };
  }

  async function classArmLookup(): Promise<Map<string, string>> {
    const [{ items: classes }, { items: arms }] = await Promise.all([
      structure.listClasses({}, { page: 1, limit: 500, sort: 'level' }),
      structure.listArms({}, { page: 1, limit: 2000, sort: 'name' }),
    ]);
    const classNames = new Map(classes.map((c) => [c.id, c.name]));
    return new Map(arms.map((a) => [`${classNames.get(a.classId) ?? ''}|${a.name}`.toLowerCase(), a.id]));
  }

  return {
    /** Validates the whole file and reports every problem. Saves nothing. */
    async upload(buffer: Buffer, actor: Actor) {
      const { header, rows } = readTable(buffer);
      const arms = await classArmLookup();
      const errors: RowError[] = [];
      const valid: ImportRow[] = [];

      rows.forEach((cells, index) => {
        const row = index + 2; // the spreadsheet row number, counting the header as row 1
        const get = (field: string): string => clean(cells[header.indexOf(field)]);
        const before = errors.length;
        const problem = (field: string, issue: string): void => void errors.push({ row, field, issue });

        const textField = (field: string, required: boolean, max: number): string | undefined => {
          const value = get(field);
          if (!value) { if (required) problem(field, 'Required'); return undefined; }
          if (value.length > max) problem(field, `At most ${max} characters`);
          else if (FORMULA_START.test(value)) problem(field, 'Must not start with = + - or @');
          return value;
        };

        const firstName = textField('firstName', true, 60);
        const middleName = textField('middleName', false, 60);
        const lastName = textField('lastName', true, 60);
        const address = textField('address', false, 200);

        let gender: Gender | undefined;
        const rawGender = get('gender').toUpperCase();
        if (rawGender) {
          const mapped = rawGender === 'M' ? 'MALE' : rawGender === 'F' ? 'FEMALE' : rawGender;
          if ((GENDERS as readonly string[]).includes(mapped)) gender = mapped as Gender;
          else problem('gender', 'Use MALE or FEMALE');
        }

        let dateOfBirth: string | undefined;
        const rawDob = get('dateOfBirth');
        if (rawDob) {
          const date = new Date(rawDob);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDob) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== rawDob) problem('dateOfBirth', 'Use the format YYYY-MM-DD');
          else if (date > new Date() || date.getUTCFullYear() < 1900) problem('dateOfBirth', 'Not a sensible date of birth');
          else dateOfBirth = rawDob;
        }

        let email: string | undefined;
        if (get('email')) {
          email = normalizeEmail(get('email')) ?? undefined;
          if (!email) problem('email', 'Invalid email address');
        }
        let phone: string | undefined;
        if (get('phone')) {
          phone = normalizePhone(get('phone')) ?? undefined;
          if (!phone) problem('phone', 'Invalid phone number');
        }

        let classArmId: string | undefined;
        const className = textField('className', false, 40);
        const armName = textField('armName', false, 20);
        if (className || armName) {
          classArmId = className && armName ? arms.get(`${className}|${armName}`.toLowerCase()) : undefined;
          if (!classArmId) problem('className', 'Both className and armName are needed, and must match an existing class arm');
        }

        if (errors.length === before && firstName && lastName) {
          valid.push({
            row, firstName, lastName,
            ...(middleName ? { middleName } : {}),
            ...(gender ? { gender } : {}), ...(dateOfBirth ? { dateOfBirth } : {}), ...(address ? { address } : {}),
            ...(email ? { email } : {}), ...(phone ? { phone } : {}), ...(classArmId ? { classArmId } : {}),
          });
        }
      });

      // The same email or phone twice in the file, or already used by an existing account.
      const emailRows = new Map<string, number>();
      const phoneRows = new Map<string, number>();
      for (const r of valid) {
        if (r.email) { if (emailRows.has(r.email)) errors.push({ row: r.row, field: 'email', issue: `Same as row ${emailRows.get(r.email)}` }); else emailRows.set(r.email, r.row); }
        if (r.phone) { if (phoneRows.has(r.phone)) errors.push({ row: r.row, field: 'phone', issue: `Same as row ${phoneRows.get(r.phone)}` }); else phoneRows.set(r.phone, r.row); }
      }
      const taken = await users.findExistingContacts([...emailRows.keys()], [...phoneRows.keys()]);
      for (const r of valid) {
        if (r.email && taken.emails.has(r.email)) errors.push({ row: r.row, field: 'email', issue: 'Already in use' });
        if (r.phone && taken.phones.has(r.phone)) errors.push({ row: r.row, field: 'phone', issue: 'Already in use' });
      }

      errors.sort((a, b) => a.row - b.row);
      const clean_ = errors.length === 0;
      let importToken: string | null = null;
      if (clean_) {
        importToken = randomBytes(32).toString('base64url');
        await store.setMany([{ key: keyOf(importToken), value: JSON.stringify({ actorId: actor.id, rows: valid }), ttlSeconds: TOKEN_TTL_SECONDS }]);
      }

      return {
        rowCount: rows.length,
        validCount: clean_ ? valid.length : rows.length - new Set(errors.map((e) => e.row)).size,
        errors: errors.slice(0, MAX_REPORTED_ERRORS),
        truncated: errors.length > MAX_REPORTED_ERRORS,
        importToken,
      };
    },

    /** Saves a clean upload. A row that fails (for example a race on an email) is reported and does not stop the rest. */
    async confirm(token: string, actor: Actor, ctx: Context) {
      if (!TOKEN.test(token)) throw new AppError('IMPORT_TOKEN_EXPIRED');
      // Atomic: the token works once.
      const raw = await store.getAndDelete(keyOf(token));
      let stored: { actorId: string; rows: ImportRow[] } | null = null;
      try { stored = raw ? (JSON.parse(raw) as { actorId: string; rows: ImportRow[] }) : null; } catch { stored = null; }
      if (!stored || stored.actorId !== actor.id) throw new AppError('IMPORT_TOKEN_EXPIRED');

      const created: { row: number; id: string; admissionNo: string; name: string; temporaryPassword: string }[] = [];
      const failed: { row: number; reason: string }[] = [];

      for (const r of stored.rows) {
        try {
          const result = await students.create(
            {
              firstName: r.firstName, middleName: r.middleName, lastName: r.lastName, gender: r.gender, dateOfBirth: r.dateOfBirth, address: r.address,
              email: r.email, phone: r.phone, classArmId: r.classArmId, delivery: 'TEMPORARY_PASSWORD',
            },
            actor,
            ctx,
          );
          created.push({
            row: r.row, id: result.account.id, admissionNo: result.account.admissionNo,
            name: [r.firstName, r.middleName, r.lastName].filter(Boolean).join(' '), temporaryPassword: result.temporaryPassword ?? '',
          });
        } catch (err) {
          if (!isAppError(err)) logger.error({ err, row: r.row }, 'student import row failed');
          failed.push({ row: r.row, reason: isAppError(err) ? (err.details?.[0]?.issue ?? err.message) : 'Unexpected error' });
        }
      }

      await recordSafely(audit, {
        action: 'STUDENT_IMPORT', actorId: actor.id, entityType: 'student', ip: ctx.ip, requestId: ctx.requestId,
        metadata: { created: created.length, failed: failed.length },
      });
      return { created, failed };
    },
  };
}

export type StudentImportService = ReturnType<typeof createStudentImportService>;