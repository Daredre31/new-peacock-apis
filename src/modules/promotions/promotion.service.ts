import { AppError } from '../../common/errors/AppError';
import type { enrolmentRepository } from '../academics/enrolment.repository';
import type { sessionRepository } from '../academics/session.repository';
import type { structureRepository } from '../academics/structure.repository';
import type { invoiceRepository } from '../fees/invoice.repository';
import type { AnnualResultsService } from '../results/annualResults.service';
import type { SettingsService } from '../settings/settings.service';
import type { studentRepository } from '../users/student.repository';
import { decide, OUTCOME, REASON, type Outcome, type Reason } from './promotion.plan';

export type IssueCode = 'TARGET_SESSION_NOT_AFTER_SOURCE' | 'TERMS_NOT_CLOSED' | 'TARGET_ARM_MISSING' | 'NO_STUDENTS';
export interface Issue { code: IssueCode; message: string }

export interface PreviewStudent {
  studentId: string; name: string; admissionNo: string;
  average: number | null; grade: string | null; position: number | null; complete: boolean;
  outcome: Outcome; blocked: boolean; reasons: Reason[]; owingKobo: number;
}
export interface PromotionPreview {
  passMarkPercent: number;
  source: { session: { id: string; name: string }; classArm: { id: string; name: string }; termsClosed: boolean };
  target: {
    session: { id: string; name: string };
    nextClass: { id: string; name: string; level: number } | null;
    arm: { id: string; name: string } | null;
    isFinalClass: boolean;
  };
  issues: Issue[];
  summary: Record<'promote' | 'repeat' | 'graduate' | 'needsDecision' | 'alreadyEnrolled' | 'notEligible' | 'blockedByFees', number>;
  students: PreviewStudent[];
}

export function createPromotionService(deps: {
  annual: Pick<AnnualResultsService, 'forArm'>;
  settings: Pick<SettingsService, 'getPolicy'>;
  sessions: Pick<typeof sessionRepository, 'findSession' | 'findTermsOfSession'>;
  structure: Pick<typeof structureRepository, 'findArm' | 'classesByIds' | 'nextClassAfter' | 'findArmByName'>;
  enrolments: Pick<typeof enrolmentRepository, 'forStudents'>;
  students: Pick<typeof studentRepository, 'findManyByUserIds'>;
  invoices: Pick<typeof invoiceRepository, 'outstandingForStudents'>;
}) {
  const { annual, settings, sessions, structure, enrolments, students, invoices } = deps;
  const invalid = (field: string, issue: string): AppError => new AppError('VALIDATION_ERROR', { details: [{ field, issue }] });

  return {
    /**
     * What would happen to every student in a class when the school moves from one session to the next.
     * Read-only: nothing is saved, so it can be run as often as needed.
     */
    async preview(input: { classArmId: string; sessionId: string; targetSessionId: string; targetArmId?: string | undefined }): Promise<PromotionPreview> {
      const [sourceSession, targetSession, arm] = await Promise.all([
        sessions.findSession(input.sessionId), sessions.findSession(input.targetSessionId), structure.findArm(input.classArmId),
      ]);
      if (!sourceSession || !targetSession || !arm) throw new AppError('NOT_FOUND');

      const issues: Issue[] = [];
      if (targetSession.startDate.getTime() <= sourceSession.startDate.getTime()) {
        issues.push({ code: 'TARGET_SESSION_NOT_AFTER_SOURCE', message: 'The target session must start after the session being closed' });
      }
      const terms = await sessions.findTermsOfSession(sourceSession.id);
      const termsClosed = terms.length > 0 && terms.every((t) => t.locked);
      if (!termsClosed) issues.push({ code: 'TERMS_NOT_CLOSED', message: 'Every term of the session must be closed before students are promoted' });

      const [classes, policy, results] = await Promise.all([
        structure.classesByIds([arm.classId]), settings.getPolicy(), annual.forArm(arm.id, sourceSession.id),
      ]);
      const currentClass = classes.get(arm.classId);
      if (!currentClass) throw new AppError('NOT_FOUND');
      const nextClass = await structure.nextClassAfter(currentClass.level);
      const isFinalClass = nextClass === null;

      // The arm students move into: the one named by the admin, else the arm with the same name one class up.
      let targetArm: { id: string; name: string } | null = null;
      if (nextClass) {
        if (input.targetArmId) {
          const chosen = await structure.findArm(input.targetArmId);
          if (!chosen) throw invalid('targetArmId', 'That class arm does not exist');
          if (chosen.classId !== nextClass.id) throw invalid('targetArmId', `That arm is not in ${nextClass.name}, the next class`);
          targetArm = { id: chosen.id, name: chosen.name };
        } else {
          const matched = await structure.findArmByName(nextClass.id, arm.name);
          if (matched) targetArm = { id: matched.id, name: matched.name };
        }
        if (!targetArm) issues.push({ code: 'TARGET_ARM_MISSING', message: `${nextClass.name} has no arm named "${arm.name}". Create it, or choose the arm to move this class into` });
      }
      if (results.students.length === 0) issues.push({ code: 'NO_STUDENTS', message: 'No students are enrolled in this class for the session' });

      const studentIds = results.students.map((s) => s.studentId);
      const [records, owing, already] = await Promise.all([
        students.findManyByUserIds(studentIds), invoices.outstandingForStudents(studentIds), enrolments.forStudents(studentIds, targetSession.id),
      ]);
      const statusOf = new Map(records.map((r) => [r.userId, r.status]));

      const rows = results.students.map((s): PreviewStudent => {
        const owingKobo = owing.get(s.studentId) ?? 0;
        const decision = decide(
          { status: statusOf.get(s.studentId) ?? null, alreadyEnrolled: already.has(s.studentId), average: s.average, complete: s.complete, owingKobo },
          { passMarkPercent: policy.promotionPassMarkPercent, isFinalClass },
        );
        return {
          studentId: s.studentId, name: s.name, admissionNo: s.admissionNo, average: s.average, grade: s.grade, position: s.position,
          complete: s.complete, outcome: decision.outcome, blocked: decision.blocked, reasons: decision.reasons, owingKobo,
        };
      });

      const count = (o: Outcome): number => rows.filter((r) => r.outcome === o).length;
      return {
        passMarkPercent: policy.promotionPassMarkPercent,
        source: { session: { id: sourceSession.id, name: sourceSession.name }, classArm: results.classArm, termsClosed },
        target: {
          session: { id: targetSession.id, name: targetSession.name },
          nextClass: nextClass ? { id: nextClass.id, name: nextClass.name, level: nextClass.level } : null,
          arm: targetArm, isFinalClass,
        },
        issues,
        summary: {
          promote: count(OUTCOME.PROMOTE), repeat: count(OUTCOME.REPEAT), graduate: count(OUTCOME.GRADUATE),
          needsDecision: count(OUTCOME.NEEDS_DECISION), alreadyEnrolled: count(OUTCOME.ALREADY_ENROLLED), notEligible: count(OUTCOME.NOT_ELIGIBLE),
          blockedByFees: rows.filter((r) => r.blocked && r.reasons.includes(REASON.OWES_FEES)).length,
        },
        students: rows,
      };
    },
  };
}

export type PromotionService = ReturnType<typeof createPromotionService>;
