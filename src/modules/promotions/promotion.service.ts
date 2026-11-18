import { AppError } from '../../common/errors/AppError';
import { logger } from '../../common/utils/logger';
import { withTransaction } from '../../config/db';
import type { AuditPort } from '../audit/audit.port';
import type { enrolmentRepository } from '../academics/enrolment.repository';
import type { sessionRepository } from '../academics/session.repository';
import type { structureRepository } from '../academics/structure.repository';
import type { invoiceRepository } from '../fees/invoice.repository';
import type { AnnualResultsService } from '../results/annualResults.service';
import type { NotificationService } from '../notifications/notification.service';
import type { SettingsService } from '../settings/settings.service';
import type { linkRepository } from '../users/link.repository';
import type { studentRepository } from '../users/student.repository';
import type { userRepository } from '../users/user.repository';
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

export type Decision = 'PROMOTE' | 'REPEAT' | 'GRADUATE';
export type SkipReason = 'ALREADY_ENROLLED' | 'NOT_ELIGIBLE' | 'NEEDS_DECISION' | 'OWES_FEES' | 'CHANGED_MEANWHILE';
export interface Override { studentId: string; outcome: Decision; reason: string }
export interface CommitInput { classArmId: string; sessionId: string; targetSessionId: string; targetArmId?: string | undefined; overrides: Override[] }
export interface CommitResult {
  summary: { applied: number; skipped: number; failed: number };
  applied: { studentId: string; name: string; outcome: Decision }[];
  skipped: { studentId: string; name: string; reason: SkipReason }[];
  failed: { studentId: string; name: string }[];
}
interface Actor { id: string }
interface Context { ip: string; requestId: string }

/** Thrown inside a student's transaction to undo it when the record changed under us. */
class ChangedMeanwhile extends Error {}

export function createPromotionService(deps: {
  annual: Pick<AnnualResultsService, 'forArm'>;
  settings: Pick<SettingsService, 'getPolicy'>;
  sessions: Pick<typeof sessionRepository, 'findSession' | 'findTermsOfSession'>;
  structure: Pick<typeof structureRepository, 'findArm' | 'classesByIds' | 'nextClassAfter' | 'findArmByName'>;
  enrolments: Pick<typeof enrolmentRepository, 'forStudents' | 'applyOutcome'>;
  students: Pick<typeof studentRepository, 'findManyByUserIds' | 'markGraduated'>;
  invoices: Pick<typeof invoiceRepository, 'outstandingForStudents'>;
  users: Pick<typeof userRepository, 'setReadOnly'>;
  links: Pick<typeof linkRepository, 'activeParentIdsOf'>;
  notifier: Pick<NotificationService, 'notify'>;
  audit: AuditPort;
}) {
  const { annual, settings, sessions, structure, enrolments, students, invoices, users, links, notifier, audit } = deps;
  const invalid = (field: string, issue: string): AppError => new AppError('VALIDATION_ERROR', { details: [{ field, issue }] });

  const service = {
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

    /**
     * Moves a class into the next session. The plan is worked out again here from the database, never taken from
     * the client, and only the overrides in the request can change it. Each student is saved in their own
     * transaction, so a failure on one leaves the others done and the whole call safe to run again.
     *
     * Refused outright while the preview shows any issue. Students owing fees cannot be promoted or graduated,
     * and an override cannot lift that.
     */
    async commit(input: CommitInput, actor: Actor, ctx: Context): Promise<CommitResult> {
      const plan = await service.preview(input);
      if (plan.issues.length > 0) {
        throw new AppError('CONFLICT', { details: plan.issues.map((i) => ({ field: i.code, issue: i.message })) });
      }

      const rowOf = new Map(plan.students.map((r) => [r.studentId, r]));
      const overrideOf = new Map<string, Override>();
      input.overrides.forEach((o, i) => {
        const field = `overrides.${i}`;
        if (overrideOf.has(o.studentId)) throw invalid(field, 'This student appears more than once');
        if (!rowOf.has(o.studentId)) throw invalid(field, 'This student is not in the class');
        if (o.outcome === 'GRADUATE' && !plan.target.isFinalClass) throw invalid(field, 'Only the top class can graduate');
        if (o.outcome === 'PROMOTE' && plan.target.isFinalClass) throw invalid(field, 'The top class has no next class. Use GRADUATE');
        overrideOf.set(o.studentId, o);
      });

      const result: CommitResult = { summary: { applied: 0, skipped: 0, failed: 0 }, applied: [], skipped: [], failed: [] };
      const sourceArmId = plan.source.classArm.id;

      for (const row of plan.students) {
        const skip = (reason: SkipReason): void => { result.skipped.push({ studentId: row.studentId, name: row.name, reason }); };
        if (row.outcome === OUTCOME.ALREADY_ENROLLED || row.outcome === OUTCOME.NOT_ELIGIBLE) { skip(row.outcome); continue; }

        const chosen: Decision | null = overrideOf.get(row.studentId)?.outcome
          ?? (row.outcome === OUTCOME.PROMOTE || row.outcome === OUTCOME.REPEAT || row.outcome === OUTCOME.GRADUATE ? row.outcome : null);
        if (!chosen) { skip('NEEDS_DECISION'); continue; }
        if (chosen !== 'REPEAT' && row.owingKobo > 0) { skip('OWES_FEES'); continue; }

        const nextArmId = chosen === 'PROMOTE' ? plan.target.arm?.id : sourceArmId;
        if (chosen !== 'GRADUATE' && !nextArmId) { skip('CHANGED_MEANWHILE'); continue; }

        try {
          const outcome = await withTransaction(async (tx) => {
            const done = await enrolments.applyOutcome({
              studentId: row.studentId, fromSessionId: plan.source.session.id, fromArmId: sourceArmId,
              outcome: chosen === 'PROMOTE' ? 'PROMOTED' : chosen === 'REPEAT' ? 'REPEATED' : 'GRADUATED',
              ...(chosen !== 'GRADUATE' && nextArmId ? { next: { sessionId: plan.target.session.id, classArmId: nextArmId } } : {}),
            }, tx);
            if (done !== 'APPLIED') return done;
            if (chosen === 'GRADUATE') {
              if (!(await students.markGraduated(row.studentId, tx))) throw new ChangedMeanwhile();
              await users.setReadOnly(row.studentId, true, tx);
            }
            return done;
          });
          if (outcome === 'APPLIED') result.applied.push({ studentId: row.studentId, name: row.name, outcome: chosen });
          else skip(outcome === 'ALREADY_ENROLLED' ? 'ALREADY_ENROLLED' : 'CHANGED_MEANWHILE');
        } catch (err) {
          if (err instanceof ChangedMeanwhile) { skip('CHANGED_MEANWHILE'); continue; }
          logger.error({ err, studentId: row.studentId, requestId: ctx.requestId }, 'promotion failed for one student');
          result.failed.push({ studentId: row.studentId, name: row.name });
        }
      }
      result.summary = { applied: result.applied.length, skipped: result.skipped.length, failed: result.failed.length };

      // The students are already saved. Neither the audit entry nor the notices may turn that into an error.
      try {
        await audit.record({
          action: 'PROMOTION_COMMITTED', actorId: actor.id, entityType: 'ClassArm', entityId: sourceArmId, ip: ctx.ip, requestId: ctx.requestId,
          metadata: {
            fromSessionId: plan.source.session.id, toSessionId: plan.target.session.id, toArmId: plan.target.arm?.id ?? null,
            passMarkPercent: plan.passMarkPercent, summary: result.summary,
            overrides: input.overrides.map((o) => ({ studentId: o.studentId, outcome: o.outcome, reason: o.reason, proposed: rowOf.get(o.studentId)?.outcome })),
            graduated: result.applied.filter((a) => a.outcome === 'GRADUATE').map((a) => a.studentId),
          },
        });
      } catch (err) {
        logger.error({ err, requestId: ctx.requestId }, 'promotion audit entry could not be written');
      }

      try {
        for (const a of result.applied) {
          const parentIds = await links.activeParentIdsOf([a.studentId]);
          if (parentIds.length === 0) continue;
          const body = a.outcome === 'PROMOTE'
            ? `${a.name} has been promoted to ${plan.target.nextClass?.name ?? ''} ${plan.target.arm?.name ?? ''} for the ${plan.target.session.name} session.`.replace(/\s+/g, ' ')
            : a.outcome === 'REPEAT'
              ? `${a.name} will repeat ${plan.source.classArm.name} in the ${plan.target.session.name} session.`
              : `${a.name} has graduated. Results and report cards stay available to view.`;
          await notifier.notify({ userIds: parentIds, type: 'PROMOTION_OUTCOME', title: 'End of session outcome', body, data: { studentId: a.studentId }, email: true });
        }
      } catch (err) {
        logger.error({ err, requestId: ctx.requestId }, 'promotion notices could not be sent');
      }
      return result;
    },
  };
  return service;
}

export type PromotionService = ReturnType<typeof createPromotionService>;
