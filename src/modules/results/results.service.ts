import { AppError } from '../../common/errors/AppError';
import type { enrolmentRepository } from '../academics/enrolment.repository';
import type { attendanceRepository } from '../attendance/attendance.repository';
import { recordSafely, type AuditPort } from '../audit/audit.port';
import type { NotificationService } from '../notifications/notification.service';
import { gradeFor, type AssessmentConfig } from '../settings/assessment';
import type { linkRepository } from '../users/link.repository';
import type { reportCardRepository } from './reportCard.repository';
import { attendanceSummaryOf, termDates, type ResultsContext } from './results.context';
import { SCORE_STATUS, type scoreRepository } from './score.repository';
import { adminCanEdit, planWrites, scoreKey, type PlanEntry } from './scores.plan';
import { writeScores } from './scores.service';

interface Actor { id: string }
interface Context { ip: string; requestId: string }

export interface ResultsServiceDeps {
  ctx: ResultsContext;
  scores: typeof scoreRepository;
  settings: { getAssessment(): Promise<AssessmentConfig> };
  reportCards: Pick<typeof reportCardRepository, 'snapshotAttendance'>;
  attendance: Pick<typeof attendanceRepository, 'summaryForMany'>;
  enrolments: Pick<typeof enrolmentRepository, 'studentIdsInArms'>;
  links: Pick<typeof linkRepository, 'activeParentIdsOf'>;
  notifier: Pick<NotificationService, 'notify'>;
  audit: AuditPort;
}

const stageLabel = (minRank: number): string => (minRank < 0 ? 'NOT_STARTED' : (['DRAFT', 'SUBMITTED', 'MODERATED', 'PUBLISHED'] as const)[minRank] ?? 'DRAFT');

export function createResultsService(deps: ResultsServiceDeps) {
  const { ctx, scores, settings, reportCards, attendance, links, notifier, audit } = deps;

  const log = (action: string, actor: Actor, c: Context, armId: string, metadata: Record<string, unknown>) =>
    recordSafely(audit, { action, actorId: actor.id, entityType: 'results', entityId: armId, ip: c.ip, requestId: c.requestId, metadata });

  /** Freezes attendance onto the report cards, so a published card never shifts under the parent. */
  async function snapshotAttendance(armId: string, termId: string): Promise<void> {
    const { term, studentIds } = await ctx.armTerm(armId, termId);
    const { from, to } = termDates(term);
    const counts = await attendance.summaryForMany(studentIds, from, to);
    await reportCards.snapshotAttendance(armId, termId, new Map(studentIds.map((id) => [id, attendanceSummaryOf(counts.get(id))])));
  }

  async function requireReady(armId: string, termId: string, minRank: number, what: string) {
    const ready = await ctx.readiness(armId, termId);
    if (!ready.hasSubjects) throw new AppError('CONFLICT', { message: 'No teachers are assigned to subjects in this class for this session' });
    if (ready.studentCount === 0) throw new AppError('CONFLICT', { message: 'No students are enrolled in this class for this session' });
    const behind = ready.subjects.filter((s) => s.minRank < minRank);
    if (behind.length > 0) {
      throw new AppError('CONFLICT', {
        message: `Some subjects are not ${what} yet`,
        details: behind.slice(0, 50).map((s) => ({ field: s.subjectName, issue: `${s.entered} of ${s.students} students have scores` })),
      });
    }
    return ready;
  }

  return {
    /** The class results sheet: every student against every subject, with positions and where each subject stands. */
    async sheet(armId: string, termId: string) {
      const [results, ready] = await Promise.all([ctx.compute(armId, termId), ctx.readiness(armId, termId)]);
      const stage = results.published ? 'PUBLISHED' : ready.allModerated ? 'MODERATED' : ready.allSubmitted ? 'SUBMITTED' : 'IN_PROGRESS';

      return {
        classArm: { id: results.arm.id, name: results.classArmName }, term: { id: results.term.id, name: results.term.name },
        stage, published: results.published, locked: results.locked,
        subjects: ready.subjects.map((s) => ({ subjectId: s.subjectId, subjectName: s.subjectName, students: s.students, entered: s.entered, stage: stageLabel(s.minRank) })),
        students: results.students.map((s) => ({
          studentId: s.studentId, name: s.name, admissionNo: s.admissionNo, position: s.position, grandTotal: s.grandTotal, average: s.average,
          scores: results.subjects.map((sub) => {
            const line = s.lines.get(sub.id);
            return { subjectId: sub.id, total: line?.total ?? null, grade: line?.grade ?? null, status: line?.status ?? null };
          }),
        })),
      };
    },

    /** The admin checks the class, optionally adjusts scores, and moves every submitted subject to "moderated". */
    async moderate(actor: Actor, armId: string, termId: string, input: { adjustments?: PlanEntry[] | undefined; note?: string | undefined }, c: Context) {
     await requireReady(armId, termId, 1, 'submitted');

      let adjusted = 0;
      if (input.adjustments && input.adjustments.length > 0) {
        const [config, docs, base] = await Promise.all([settings.getAssessment(), scores.forArmTerm(armId, termId), ctx.armTerm(armId, termId)]);
        const plan = planWrites({
          armId, termId, entries: input.adjustments, existing: new Map(docs.map((d) => [scoreKey(d.studentId, d.subjectId), d])),
          enrolled: new Set(base.studentIds), config, canEdit: adminCanEdit,
        });
        await writeScores(scores, plan.writes, actor.id);
        adjusted = plan.writes.length;
        await log('SCORES_ADJUSTED', actor, c, armId, { termId, adjusted, note: input.note ?? null, changes: plan.changes.slice(0, 40) });
      }

      const moderated = await scores.transition({ classArmId: armId, termId }, SCORE_STATUS.SUBMITTED, SCORE_STATUS.MODERATED);
      await log('RESULTS_MODERATED', actor, c, armId, { termId, moderated, adjusted });
      return { moderated, adjusted };
    },

    /** Publishes the class's results. Scores are locked at once, and only the super admin can unlock them. */
    async publish(actor: Actor, armId: string, termId: string, c: Context) {
      const before = await ctx.readiness(armId, termId);
      if (before.allPublished) return { published: 0, alreadyPublished: true };
      await requireReady(armId, termId, 2, 'moderated');

      const config = await settings.getAssessment();
      const docs = (await scores.forArmTerm(armId, termId)).filter((d) => d.status === SCORE_STATUS.MODERATED);
      const applied = await scores.stampMany(
        docs.map((d) => ({ id: d.id, rev: d.rev, ...gradeFor(d.total, config.bands) })),
        SCORE_STATUS.MODERATED, SCORE_STATUS.PUBLISHED, true,
      );
      if (applied !== docs.length) throw new AppError('CONFLICT', { message: 'Scores changed while publishing. Nothing was lost, please try again.' });

      await snapshotAttendance(armId, termId);

      const { term, arm, studentIds } = await ctx.armTerm(armId, termId);
      const parents = await links.activeParentIdsOf(studentIds);
      await notifier.notify({
        userIds: [...studentIds, ...parents], type: 'RESULTS_PUBLISHED', title: 'Results published',
        body: `${term.name} results for ${arm.name} are now available.`, data: { termId }, email: false,
      });
      await log('RESULTS_PUBLISHED', actor, c, armId, { termId, published: docs.length });
      return { published: docs.length, alreadyPublished: false };
    },

    /** Locks published results again after a correction, re-stamping grades and attendance. */
    async lock(actor: Actor, armId: string, termId: string, c: Context) {
      await ctx.armTerm(armId, termId);
      const published = (await scores.forArmTerm(armId, termId)).filter((d) => d.status === SCORE_STATUS.PUBLISHED);
      if (published.length === 0) throw new AppError('CONFLICT', { message: 'Nothing is published for this class and term' });
      if (published.every((d) => d.locked)) return { changed: 0 };

      const config = await settings.getAssessment();
      const applied = await scores.stampMany(
        published.map((d) => ({ id: d.id, rev: d.rev, ...gradeFor(d.total, config.bands) })),
        SCORE_STATUS.PUBLISHED, SCORE_STATUS.PUBLISHED, true,
      );
      if (applied !== published.length) throw new AppError('CONFLICT', { message: 'Scores changed while locking. Please try again.' });
      await snapshotAttendance(armId, termId);
      await log('RESULTS_LOCKED', actor, c, armId, { termId, changed: applied });
      return { changed: applied };
    },

    /** The super admin opens published results for correction. The reason is recorded in the audit log. */
    async unlock(actor: Actor, armId: string, termId: string, input: { reason: string }, c: Context) {
      await ctx.armTerm(armId, termId);
      const changed = await scores.setLocked(armId, termId, false);
      if (changed === 0) throw new AppError('CONFLICT', { message: 'There are no locked published results for this class and term' });
      await log('RESULTS_UNLOCKED', actor, c, armId, { termId, changed, reason: input.reason });
      return { changed };
    },
  };
}

export type ResultsService = ReturnType<typeof createResultsService>;
