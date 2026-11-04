import { AppError } from '../../common/errors/AppError';
import { daysBetween, isIsoDate, schoolToday } from '../../common/utils/dates';
import type { enrolmentRepository } from '../academics/enrolment.repository';
import type { sessionRepository } from '../academics/session.repository';
import type { structureRepository } from '../academics/structure.repository';
import type { attendanceRepository } from '../attendance/attendance.repository';
import { attendanceSummaryOf, type ResultsContext } from '../results/results.context';
import type { studentRepository } from '../users/student.repository';
import type { TableData } from './report.formats';
import type { ReportParams, ReportType } from './report.repository';

const MAX_ROWS = 5000;
const MAX_RANGE_DAYS = 120;

export interface ReportInput {
  sessionId?: string | undefined; termId?: string | undefined; classArmId?: string | undefined;
  from?: string | undefined; to?: string | undefined;
}

const fail = (field: string, issue: string): AppError => new AppError('VALIDATION_ERROR', { details: [{ field, issue }] });
const tooMany = (): AppError => new AppError('VALIDATION_ERROR', { message: 'Too many rows. Choose a class to narrow the report' });

export function createReportGenerators(deps: {
  sessions: Pick<typeof sessionRepository, 'findSession' | 'findCurrentSession'>;
  enrolments: Pick<typeof enrolmentRepository, 'listForSession'>;
  students: Pick<typeof studentRepository, 'findManyByUserIds'>;
  attendance: Pick<typeof attendanceRepository, 'summaryForMany'>;
  structure: Pick<typeof structureRepository, 'findArm' | 'armsByIds' | 'classesByIds'>;
  results: Pick<ResultsContext, 'armTerm' | 'compute'>;
}) {
  const { sessions, enrolments, students, attendance, structure, results } = deps;

  async function armLabels(ids: string[]): Promise<Map<string, string>> {
    const arms = await structure.armsByIds(ids);
    const classes = await structure.classesByIds([...arms.values()].map((a) => a.classId));
    return new Map([...arms].map(([id, a]) => [id, `${classes.get(a.classId)?.name ?? ''} ${a.name}`.trim()]));
  }

  async function checkedArm(armId: string | undefined): Promise<string | undefined> {
    if (!armId) return undefined;
    if (!(await structure.findArm(armId))) throw fail('classArmId', 'Class arm not found');
    return armId;
  }

  async function sessionOf(sessionId: string | undefined) {
    const session = sessionId ? await sessions.findSession(sessionId) : await sessions.findCurrentSession();
    if (!session) throw fail('sessionId', sessionId ? 'Session not found' : 'There is no current session');
    return session;
  }

  const generators: Record<ReportType, { prepare(input: ReportInput): Promise<ReportParams>; run(params: ReportParams): Promise<TableData> }> = {
    // Everyone enrolled in a session, with their class.
    ENROLMENT: {
      async prepare(input) {
        const session = await sessionOf(input.sessionId);
        const armId = await checkedArm(input.classArmId);
        return { sessionId: session.id, ...(armId ? { classArmId: armId } : {}) };
      },
      async run(params) {
        const session = await sessionOf(params.sessionId);
        const enrolled = await enrolments.listForSession(session.id, params.classArmId, MAX_ROWS + 1);
        if (enrolled.length > MAX_ROWS) throw tooMany();

        const [records, labels] = await Promise.all([students.findManyByUserIds(enrolled.map((e) => e.studentId)), armLabels(enrolled.map((e) => e.classArmId))]);
        const arm = new Map(enrolled.map((e) => [e.studentId, e.classArmId]));
        const rows = records
          .map((s) => ({ class: labels.get(arm.get(s.userId) ?? '') ?? '', s }))
          .sort((a, b) => a.class.localeCompare(b.class) || a.s.lastName.localeCompare(b.s.lastName))
          .map(({ class: c, s }) => [s.admissionNo, s.lastName, s.firstName, s.gender, c, s.status]);

        return {
          title: 'Enrolment', subtitle: `${session.name}${params.classArmId ? ` - ${labels.get(params.classArmId) ?? ''}` : ''}. Generated ${schoolToday()}`,
          columns: ['Admission No', 'Last name', 'First name', 'Gender', 'Class', 'Status'], rows,
        };
      },
    },

    // Attendance counts and rate per student over a date range, for the current session's classes.
    ATTENDANCE: {
      async prepare(input) {
        if (!input.from || !isIsoDate(input.from)) throw fail('from', 'Use the format YYYY-MM-DD');
        if (!input.to || !isIsoDate(input.to)) throw fail('to', 'Use the format YYYY-MM-DD');
        if (input.to < input.from) throw fail('to', 'Must not be before "from"');
        if (daysBetween(input.from, input.to) + 1 > MAX_RANGE_DAYS) throw fail('to', `At most ${MAX_RANGE_DAYS} days`);
        const session = await sessionOf(undefined);
        const armId = await checkedArm(input.classArmId);
        return { from: input.from, to: input.to, sessionId: session.id, ...(armId ? { classArmId: armId } : {}) };
      },
      async run(params) {
        const from = params.from ?? '';
        const to = params.to ?? '';
        const enrolled = await enrolments.listForSession(params.sessionId ?? '', params.classArmId, MAX_ROWS + 1);
        if (enrolled.length > MAX_ROWS) throw tooMany();

        const ids = enrolled.map((e) => e.studentId);
        const [records, counts, labels] = await Promise.all([students.findManyByUserIds(ids), attendance.summaryForMany(ids, from, to), armLabels(enrolled.map((e) => e.classArmId))]);
        const arm = new Map(enrolled.map((e) => [e.studentId, e.classArmId]));
        const rows = records
          .map((s) => ({ class: labels.get(arm.get(s.userId) ?? '') ?? '', s, a: attendanceSummaryOf(counts.get(s.userId)) }))
          .sort((a, b) => a.class.localeCompare(b.class) || a.s.lastName.localeCompare(b.s.lastName))
          .map(({ class: c, s, a }) => [s.admissionNo, `${s.lastName} ${s.firstName}`, c, a.present, a.late, a.excused, a.absent, a.days, a.rate]);

        return {
          title: 'Attendance', subtitle: `${from} to ${to}${params.classArmId ? ` - ${labels.get(params.classArmId) ?? ''}` : ''}`,
          columns: ['Admission No', 'Name', 'Class', 'Present', 'Late', 'Excused', 'Absent', 'Days', 'Rate %'], rows,
        };
      },
    },

    // One class's results for a term: every subject total, the grand total, average and position.
    TERM_RESULTS: {
      async prepare(input) {
        if (!input.classArmId) throw fail('classArmId', 'Required');
        if (!input.termId) throw fail('termId', 'Required');
        await results.armTerm(input.classArmId, input.termId); // throws NOT_FOUND if either does not exist
        return { classArmId: input.classArmId, termId: input.termId };
      },
      async run(params) {
        const data = await results.compute(params.classArmId ?? '', params.termId ?? '');
        const rows = data.students.map((s) => [
          s.position, s.admissionNo, s.name, ...data.subjects.map((sub) => s.lines.get(sub.id)?.total ?? null), s.grandTotal, s.average,
        ]);
        return {
          title: 'Term results', subtitle: `${data.classArmName}, ${data.term.name}${data.published ? '' : ' (NOT YET PUBLISHED)'}`,
          columns: ['Position', 'Admission No', 'Name', ...data.subjects.map((s) => s.name), 'Total', 'Average'], rows,
        };
      },
    },
  };

  return {
    prepare: (type: ReportType, input: ReportInput): Promise<ReportParams> => generators[type].prepare(input),
    run: (type: ReportType, params: ReportParams): Promise<TableData> => generators[type].run(params),
  };
}

export type ReportGenerators = ReturnType<typeof createReportGenerators>;