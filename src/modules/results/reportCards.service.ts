import { AppError } from '../../common/errors/AppError';
import { sanitizeText } from '../../common/utils/text';
import type { attendanceRepository } from '../attendance/attendance.repository';
import { recordSafely, type AuditPort } from '../audit/audit.port';
import type { Conduct, reportCardRepository } from './reportCard.repository';
import { attendanceSummaryOf, termDates, type ResultsContext } from './results.context';
import type { scoreRepository } from './score.repository';

interface Actor { id: string }
interface Context { ip: string; requestId: string }

export function createReportCardsService(deps: {
  ctx: ResultsContext;
  reportCards: typeof reportCardRepository;
  scores: Pick<typeof scoreRepository, 'lockedExists'>;
  attendance: Pick<typeof attendanceRepository, 'summaryForMany'>;
  audit: AuditPort;
}) {
  const { ctx, reportCards, scores, attendance, audit } = deps;

  /** Only the class teacher of this arm gets in. Everyone else sees "not found". */
  async function classTeacherContext(actor: Actor, armId: string, termId: string) {
    const base = await ctx.armTerm(armId, termId);
    if (base.arm.classTeacherId !== actor.id) throw new AppError('NOT_FOUND');
    return base;
  }

  return {
    /** Attendance (live until published, then frozen), conduct, remarks, plus each student's current total and position. */
    async compile(actor: Actor, armId: string, termId: string) {
      const base = await classTeacherContext(actor, armId, termId);
      const [results, cards] = await Promise.all([ctx.compute(armId, termId), reportCards.forArmTerm(armId, termId)]);
      const { from, to } = termDates(base.term);
      const live = await attendance.summaryForMany(base.studentIds, from, to);

      return {
        classArm: { id: base.arm.id, name: results.classArmName }, term: { id: base.term.id, name: base.term.name },
        published: results.published, locked: results.locked,
        students: results.students.map((s) => {
          const card = cards.get(s.studentId);
          return {
            studentId: s.studentId, name: s.name, admissionNo: s.admissionNo,
            attendance: results.published && card?.attendance ? card.attendance : attendanceSummaryOf(live.get(s.studentId)),
            conduct: card?.conduct ?? null, remark: card?.remark ?? null,
            grandTotal: s.grandTotal, average: s.average, position: s.position,
          };
        }),
      };
    },

    async save(actor: Actor, armId: string, termId: string, entries: { studentId: string; conduct?: Conduct | undefined; remark?: string | undefined }[], c: Context) {
      const base = await classTeacherContext(actor, armId, termId);
      if (await scores.lockedExists(armId, termId)) throw new AppError('RESULT_LOCKED');

      const enrolled = new Set(base.studentIds);
      const seen = new Set<string>();
      const details = entries.flatMap((e, i) => {
        if (!enrolled.has(e.studentId)) return [{ field: `entries.${i}.studentId`, issue: 'Not enrolled in this class arm' }];
        if (seen.has(e.studentId)) return [{ field: `entries.${i}.studentId`, issue: 'Listed twice' }];
        seen.add(e.studentId);
        return [];
      });
      if (details.length > 0) throw new AppError('VALIDATION_ERROR', { details: details.slice(0, 50) });

      await reportCards.upsertMany(
        entries.map((e) => ({ studentId: e.studentId, conduct: e.conduct, remark: e.remark !== undefined ? sanitizeText(e.remark) || null : undefined })),
        armId, termId, actor.id,
      );
      await recordSafely(audit, {
        action: 'REPORT_CARDS_SAVED', actorId: actor.id, entityType: 'reportCard', entityId: armId, ip: c.ip, requestId: c.requestId,
        metadata: { termId, saved: entries.length },
      });
      return { saved: entries.length };
    },
  };
}

export type ReportCardsService = ReturnType<typeof createReportCardsService>;