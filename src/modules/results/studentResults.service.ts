import { AppError } from '../../common/errors/AppError';
import type { ScopeService } from '../../common/scope/scope.service';
import { ROLES, SCHOOL_NAME, type Role } from '../../config/constants';
import type { sessionRepository } from '../academics/session.repository';
import type { attendanceRepository } from '../attendance/attendance.repository';
import type { staffRepository } from '../users/staff.repository';
import type { reportCardRepository } from './reportCard.repository';
import { renderReportCard } from './reportCard.pdf';
import { attendanceSummaryOf, termDates, type ArmTermResults, type ResultsContext } from './results.context';
import type { scoreRepository } from './score.repository';

interface Actor { id: string; role: Role }

/** Hook for Phase 4: parents see "withheld" instead of the card while fees are owed and the school has turned that on. */
export interface ReportGate { isWithheld(studentId: string, termId: string): Promise<boolean> }
export const openReportGate: ReportGate = { isWithheld: async () => false };

export function createStudentResultsService(deps: {
  ctx: ResultsContext;
  scores: Pick<typeof scoreRepository, 'forStudent'>;
  reportCards: Pick<typeof reportCardRepository, 'forStudentTerm'>;
  sessions: Pick<typeof sessionRepository, 'findSession'>;
  staff: Pick<typeof staffRepository, 'nameMap'>;
  attendance: Pick<typeof attendanceRepository, 'summaryForMany'>;
  scope: Pick<ScopeService, 'assertCanAccessStudent'>;
  gate: ReportGate;
  school?: { getName(): Promise<string> }
}) {
  const { ctx, scores, reportCards, sessions, staff, attendance, scope, gate } = deps;

  const seesUnpublished = (role: Role): boolean => role === ROLES.ADMIN || role === ROLES.SUPER_ADMIN;
  const guarded = (role: Role): boolean => role === ROLES.PARENT || role === ROLES.STUDENT;

  /** The student's results in each term. Parents and students only see published terms. */
  async function termResults(actor: Actor, studentId: string, termId?: string) {
    await scope.assertCanAccessStudent(actor, studentId);

    const docs = await scores.forStudent(studentId, termId);
    const terms = new Map<string, string>(); // termId -> class arm id
    for (const d of docs) terms.set(d.termId, d.classArmId);

    const out: { results: ArmTermResults; studentId: string }[] = [];
    for (const [tId, armId] of terms) {
      const results = await ctx.compute(armId, tId);
      if (!results.published && !seesUnpublished(actor.role)) continue;
      if (results.students.some((s) => s.studentId === studentId)) out.push({ results, studentId });
    }
    return out.sort((a, b) => a.results.term.startDate.getTime() - b.results.term.startDate.getTime());
  }

  return {
    async results(actor: Actor, studentId: string, termId?: string) {
      const found = await termResults(actor, studentId, termId);
      const sessionNames = new Map<string, string>();
      for (const { results } of found) {
        const sid = results.term.sessionId;
        if (!sessionNames.has(sid)) sessionNames.set(sid, (await sessions.findSession(sid))?.name ?? '');
      }

      const terms = await Promise.all(
        found.map(async ({ results }) => {
          const me = results.students.find((s) => s.studentId === studentId);
          if (!me) return null;
          const withheld = guarded(actor.role) && results.published ? await gate.isWithheld(studentId, results.term.id) : false;
          return {
            termId: results.term.id, termName: results.term.name, sessionName: sessionNames.get(results.term.sessionId) ?? '',
            classArmName: results.classArmName, published: results.published,
            components: results.config.components,
            subjects: results.subjects.flatMap((sub) => {
              const line = me.lines.get(sub.id);
              return line ? [{ subjectId: sub.id, subjectName: sub.name, subjectCode: sub.code, components: line.components, total: line.total, grade: line.grade, remark: line.remark }] : [];
            }),
            grandTotal: me.grandTotal, average: me.average, position: me.position, classSize: results.students.length,
            reportCard: { available: results.published && !withheld, withheld },
          };
        }),
      );
      const list = terms.flatMap((t) => (t ? [t] : []));
      return { terms: list, trend: list.map((t) => ({ termId: t.termId, termName: t.termName, sessionName: t.sessionName, average: t.average, position: t.position })) };
    },

    /** The report card as a PDF, built on request from the same numbers as every other screen. */
    async reportCardPdf(actor: Actor, studentId: string, termId: string): Promise<{ filename: string; buffer: Buffer }> {
      const [match] = await termResults(actor, studentId, termId);
      const me = match?.results.students.find((s) => s.studentId === studentId);
      if (!match || !me) throw new AppError('NOT_FOUND');
      const { results } = match;

      if (guarded(actor.role) && (await gate.isWithheld(studentId, termId))) {
        throw new AppError('CONFLICT', { message: 'This report card is withheld until outstanding fees are cleared. Please contact the school.' });
      }

      const [card, sessionRecord, teacherNames] = await Promise.all([
        reportCards.forStudentTerm(studentId, termId), sessions.findSession(results.term.sessionId),
        results.arm.classTeacherId ? staff.nameMap([results.arm.classTeacherId]) : Promise.resolve(new Map<string, string>()),
      ]);
      const { from, to } = termDates(results.term);
      const attendanceSummary = results.published && card?.attendance
        ? card.attendance
        : attendanceSummaryOf((await attendance.summaryForMany([studentId], from, to)).get(studentId));

      const buffer = await renderReportCard({
        school: deps.school ? await deps.school.getName() : SCHOOL_NAME, studentName: me.name, admissionNo: me.admissionNo, className: results.classArmName,
        termName: results.term.name, sessionName: sessionRecord?.name ?? '',
        componentHeaders: results.config.components.map((c) => `${c.key} /${c.max}`),
        rows: results.subjects.flatMap((sub) => {
          const line = me.lines.get(sub.id);
          return line ? [{ subject: sub.name, components: results.config.components.map((c) => line.components[c.key] ?? null), total: line.total, grade: line.grade, remark: line.remark }] : [];
        }),
        grandTotal: me.grandTotal, average: me.average, position: me.position, classSize: results.students.length,
        attendance: attendanceSummary, conduct: card?.conduct ?? null, remark: card?.remark ?? null,
        classTeacher: results.arm.classTeacherId ? (teacherNames.get(results.arm.classTeacherId) ?? null) : null,
        provisional: !results.published,
      });
      return { filename: `report-card-${me.admissionNo.replace(/[^A-Za-z0-9]/g, '-')}.pdf`, buffer };
    },
  };
}

export type StudentResultsService = ReturnType<typeof createStudentResultsService>;