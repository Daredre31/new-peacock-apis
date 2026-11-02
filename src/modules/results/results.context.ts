import { AppError } from '../../common/errors/AppError';
import type { assignmentRepository } from '../academics/assignment.repository';
import type { enrolmentRepository } from '../academics/enrolment.repository';
import type { sessionRepository, TermRecord } from '../academics/session.repository';
import type { ArmRecord, structureRepository } from '../academics/structure.repository';
import { gradeFor, type AssessmentConfig } from '../settings/assessment';
import type { studentRepository } from '../users/student.repository';
import { averageOf, rankByTotal, round, totalOf, type Components } from './results.engine';
import { SCORE_STATUS, type ScoreRecord, type ScoreStatus, type scoreRepository } from './score.repository';
import type { AttendanceSummary } from './reportCard.repository';

export interface Line { components: Components; total: number; complete: boolean; grade: string; remark: string; status: ScoreStatus; locked: boolean }
export interface StudentResult {
  studentId: string; name: string; admissionNo: string; lines: Map<string, Line>;
  grandTotal: number; average: number | null; position: number;
}
export interface ArmTermResults {
  term: TermRecord; arm: ArmRecord; classArmName: string; config: AssessmentConfig;
  subjects: { id: string; name: string; code: string }[];
  students: StudentResult[];
  published: boolean; locked: boolean;
}
export interface Readiness {
  studentCount: number;
  subjects: { subjectId: string; subjectName: string; students: number; entered: number; minRank: number }[];
  hasSubjects: boolean; allSubmitted: boolean; allModerated: boolean; allPublished: boolean;
}

const RANK: Record<ScoreStatus, number> = { DRAFT: 0, SUBMITTED: 1, MODERATED: 2, PUBLISHED: 3 };

export interface ResultsContextDeps {
  scores: Pick<typeof scoreRepository, 'forArmTerm'>;
  settings: { getAssessment(): Promise<AssessmentConfig> };
  sessions: Pick<typeof sessionRepository, 'findTerm'>;
  structure: Pick<typeof structureRepository, 'findArm' | 'subjectsByIds' | 'classesByIds'>;
  assignments: Pick<typeof assignmentRepository, 'subjectIdsOfArm'>;
  enrolments: Pick<typeof enrolmentRepository, 'studentIdsInArms'>;
  students: Pick<typeof studentRepository, 'profileMap'>;
}

export function attendanceSummaryOf(counts: Record<'PRESENT' | 'ABSENT' | 'LATE' | 'EXCUSED', number> | undefined): AttendanceSummary {
  const c = counts ?? { PRESENT: 0, ABSENT: 0, LATE: 0, EXCUSED: 0 };
  const attended = c.PRESENT + c.LATE + c.EXCUSED;
  const days = attended + c.ABSENT;
  return { present: c.PRESENT, absent: c.ABSENT, late: c.LATE, excused: c.EXCUSED, days, rate: days === 0 ? null : round((attended / days) * 100) };
}

export const termDates = (term: TermRecord): { from: string; to: string } => ({
  from: term.startDate.toISOString().slice(0, 10),
  to: term.endDate.toISOString().slice(0, 10),
});

export function createResultsContext(deps: ResultsContextDeps) {
  /** The class arm, the term, who is enrolled this session and which subjects the class has teachers for. */
  async function armTerm(armId: string, termId: string) {
    const [term, arm] = await Promise.all([deps.sessions.findTerm(termId), deps.structure.findArm(armId)]);
    if (!term || !arm) throw new AppError('NOT_FOUND');
    const [studentIds, subjectIds] = await Promise.all([
      deps.enrolments.studentIdsInArms([armId], term.sessionId),
      deps.assignments.subjectIdsOfArm(armId, term.sessionId),
    ]);
    return { term, arm, studentIds, subjectIds };
  }

  async function readiness(armId: string, termId: string): Promise<Readiness> {
    const { studentIds, subjectIds } = await armTerm(armId, termId);
    const [docs, subjectMap] = await Promise.all([deps.scores.forArmTerm(armId, termId), deps.structure.subjectsByIds(subjectIds)]);

    const bySubject = new Map<string, Map<string, ScoreRecord>>();
    for (const d of docs) {
      const m = bySubject.get(d.subjectId) ?? new Map<string, ScoreRecord>();
      m.set(d.studentId, d);
      bySubject.set(d.subjectId, m);
    }

    const subjects = subjectIds.map((subjectId) => {
      const ranks = studentIds.map((s) => {
        const doc = bySubject.get(subjectId)?.get(s);
        return doc ? RANK[doc.status] : -1;
      });
      return {
        subjectId, subjectName: subjectMap.get(subjectId)?.name ?? '', students: studentIds.length,
        entered: ranks.filter((r) => r >= 0).length, minRank: ranks.length === 0 ? -1 : Math.min(...ranks),
      };
    });
    const every = (min: number): boolean => subjects.length > 0 && studentIds.length > 0 && subjects.every((s) => s.minRank >= min);
    return {
      studentCount: studentIds.length, subjects, hasSubjects: subjects.length > 0,
      allSubmitted: every(RANK.SUBMITTED), allModerated: every(RANK.MODERATED), allPublished: every(RANK.PUBLISHED),
    };
  }

  /** Totals, grades and positions for a whole class in a term. Published scores keep the grade stamped at publish time. */
  async function compute(armId: string, termId: string): Promise<ArmTermResults> {
    const base = await armTerm(armId, termId);
    const [config, docs] = await Promise.all([deps.settings.getAssessment(), deps.scores.forArmTerm(armId, termId)]);

    const subjectIds = [...new Set([...base.subjectIds, ...docs.map((d) => d.subjectId)])];
    const studentIds = [...new Set([...base.studentIds, ...docs.map((d) => d.studentId)])];
    const [subjectMap, profiles, classes] = await Promise.all([
      deps.structure.subjectsByIds(subjectIds), deps.students.profileMap(studentIds), deps.structure.classesByIds([base.arm.classId]),
    ]);

    const subjects = subjectIds
      .flatMap((id) => { const s = subjectMap.get(id); return s ? [{ id, name: s.name, code: s.code }] : []; })
      .sort((a, b) => a.name.localeCompare(b.name));

    const byStudent = new Map<string, ScoreRecord[]>();
    for (const d of docs) byStudent.set(d.studentId, [...(byStudent.get(d.studentId) ?? []), d]);

    const rows = studentIds.map((studentId) => {
      const lines = new Map<string, Line>();
      let grandTotal = 0;
      for (const d of byStudent.get(studentId) ?? []) {
        const stamped = d.status === SCORE_STATUS.PUBLISHED && d.grade !== null;
        const band = stamped ? { grade: d.grade ?? '', remark: d.remark ?? '' } : gradeFor(d.total, config.bands);
        lines.set(d.subjectId, { components: d.components, total: d.total, complete: totalOf(d.components, config).complete, grade: band.grade, remark: band.remark, status: d.status, locked: d.locked });
        grandTotal += d.total;
      }
      const profile = profiles.get(studentId);
      grandTotal = round(grandTotal);
      return { studentId, name: profile?.name ?? '', admissionNo: profile?.admissionNo ?? '', lines, grandTotal, average: averageOf(grandTotal, subjects.length), position: 0 };
    });

    const ranks = rankByTotal(new Map(rows.map((r) => [r.studentId, r.grandTotal])));
    const students = rows
      .map((r) => ({ ...r, position: ranks.get(r.studentId) ?? 0 }))
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));

    return {
      term: base.term, arm: base.arm, classArmName: `${classes.get(base.arm.classId)?.name ?? ''} ${base.arm.name}`.trim(), config, subjects, students,
      published: docs.length > 0 && docs.every((d) => d.status === SCORE_STATUS.PUBLISHED),
      locked: docs.length > 0 && docs.every((d) => d.locked),
    };
  }

  return { armTerm, readiness, compute };
}

export type ResultsContext = ReturnType<typeof createResultsContext>;