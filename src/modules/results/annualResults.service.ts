import { AppError } from '../../common/errors/AppError';
import type { enrolmentRepository } from '../academics/enrolment.repository';
import type { sessionRepository } from '../academics/session.repository';
import type { structureRepository } from '../academics/structure.repository';
import { gradeFor, type AssessmentConfig } from '../settings/assessment';
import type { studentRepository } from '../users/student.repository';
import { annualOf, rankByTotal, type AnnualScoreInput } from './results.engine';
import type { scoreRepository } from './score.repository';

export interface AnnualStudent {
  studentId: string; name: string; admissionNo: string;
  average: number | null; grade: string | null; remark: string | null; position: number | null;
  termsWithResults: number;
  /** True only when the student has published results in every term of the session. */
  complete: boolean;
  missingTermIds: string[];
  termAverages: { termId: string; average: number }[];
  subjects: { subjectId: string; average: number; termsCounted: number }[];
}

export interface AnnualArmResults {
  session: { id: string; name: string };
  classArm: { id: string; name: string };
  terms: { id: string; name: string; locked: boolean }[];
  subjects: { id: string; name: string; code: string }[];
  students: AnnualStudent[];
  /** True when every enrolled student is complete. */
  complete: boolean;
}

export function createAnnualResultsService(deps: {
  scores: Pick<typeof scoreRepository, 'publishedForStudentsInTerms'>;
  settings: { getAssessment(): Promise<AssessmentConfig> };
  sessions: Pick<typeof sessionRepository, 'findSession' | 'findTermsOfSession'>;
  structure: Pick<typeof structureRepository, 'findArm' | 'subjectsByIds' | 'classesByIds'>;
  enrolments: Pick<typeof enrolmentRepository, 'studentIdsInArms'>;
  students: Pick<typeof studentRepository, 'profileMap'>;
}) {
  const { scores, settings, sessions, structure, enrolments, students } = deps;

  return {
    /**
     * The yearly average for everyone enrolled in a class arm in a session.
     * Only PUBLISHED scores count, so nothing unfinished can leak into a promotion decision.
     * Read-only: it writes nothing.
     */
    async forArm(armId: string, sessionId: string): Promise<AnnualArmResults> {
      const [session, arm] = await Promise.all([sessions.findSession(sessionId), structure.findArm(armId)]);
      if (!session || !arm) throw new AppError('NOT_FOUND');

      const terms = (await sessions.findTermsOfSession(sessionId)).sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
      const studentIds = await enrolments.studentIdsInArms([armId], sessionId);
      const [config, docs, profiles, classes] = await Promise.all([
        settings.getAssessment(),
        scores.publishedForStudentsInTerms(studentIds, terms.map((t) => t.id)),
        students.profileMap(studentIds),
        structure.classesByIds([arm.classId]),
      ]);

      const byStudent = new Map<string, AnnualScoreInput[]>();
      for (const d of docs) byStudent.set(d.studentId, [...(byStudent.get(d.studentId) ?? []), { termId: d.termId, subjectId: d.subjectId, total: d.total }]);

      const rows = studentIds.map((studentId): AnnualStudent => {
        const outcome = annualOf(byStudent.get(studentId) ?? []);
        const have = new Set(outcome.termAverages.map((t) => t.termId));
        const band = outcome.average === null ? null : gradeFor(outcome.average, config.bands);
        const profile = profiles.get(studentId);
        return {
          studentId, name: profile?.name ?? '', admissionNo: profile?.admissionNo ?? '',
          average: outcome.average, grade: band?.grade ?? null, remark: band?.remark ?? null, position: null,
          termsWithResults: outcome.termsWithResults,
          complete: terms.length > 0 && terms.every((t) => have.has(t.id)),
          missingTermIds: terms.filter((t) => !have.has(t.id)).map((t) => t.id),
          termAverages: outcome.termAverages, subjects: outcome.subjects,
        };
      });

      const ranks = rankByTotal(new Map(rows.flatMap((r) => (r.average === null ? [] : [[r.studentId, r.average] as [string, number]]))));
      const ranked = rows
        .map((r) => ({ ...r, position: ranks.get(r.studentId) ?? null }))
        .sort((a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name));

      const subjectIds = [...new Set(ranked.flatMap((r) => r.subjects.map((s) => s.subjectId)))];
      const subjectMap = await structure.subjectsByIds(subjectIds);
      return {
        session: { id: session.id, name: session.name },
        classArm: { id: arm.id, name: `${classes.get(arm.classId)?.name ?? ''} ${arm.name}`.trim() },
        terms: terms.map((t) => ({ id: t.id, name: t.name, locked: t.locked })),
        subjects: subjectIds.flatMap((id) => { const s = subjectMap.get(id); return s ? [{ id, name: s.name, code: s.code }] : []; }).sort((a, b) => a.name.localeCompare(b.name)),
        students: ranked,
        complete: ranked.length > 0 && ranked.every((r) => r.complete),
      };
    },
  };
}

export type AnnualResultsService = ReturnType<typeof createAnnualResultsService>;
