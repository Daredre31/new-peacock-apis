import { AppError } from '../../common/errors/AppError';
import { sanitizeText } from '../../common/utils/text';
import { ROLES, type Role } from '../../config/constants';
import { withTransaction } from '../../config/db';
import type { ExamScheduler } from '../../jobs/exam.jobs';
import type { enrolmentRepository } from '../academics/enrolment.repository';
import { recordSafely, type AuditPort } from '../audit/audit.port';
import type { NotificationService } from '../notifications/notification.service';
import type { staffRepository } from '../users/staff.repository';
import { ATTEMPT_STATUS, type attemptRepository } from './attempt.repository';
import { EXAM_STATUS } from './cbt.types';
import type { ExamRecord, examRepository } from './exam.repository';
import type { pauseRepository } from './pause.repository';

interface Actor { id: string; role: Role }
interface Context { ip: string; requestId: string }

const RESCHEDULE_BATCH = 25;
const isAdmin = (role: Role): boolean => role === ROLES.ADMIN || role === ROLES.SUPER_ADMIN;

/**
 * Pausing stops an exam's clock for everyone sitting it. While it is paused nobody can start, save or submit;
 * their saved answers are kept. Resuming moves every running attempt's end time, and the exam's window end,
 * forward by the length of the pause, so the pause never costs anyone time.
 */
export function createPauseService(deps: {
  exams: Pick<typeof examRepository, 'findById' | 'pause' | 'resume'>;
  attempts: Pick<typeof attemptRepository, 'extendActive' | 'runningTimes' | 'findByExamStudent'>;
  pauses: typeof pauseRepository;
  enrolments: Pick<typeof enrolmentRepository, 'forStudents'>;
  staff: Pick<typeof staffRepository, 'nameMap'>;
  scheduler: ExamScheduler;
  notifier: Pick<NotificationService, 'notify'>;
  audit: AuditPort;
}) {
  const { exams, attempts, pauses, enrolments, staff, scheduler, notifier, audit } = deps;

  /** The teacher who owns the exam, an admin or the super admin. Everyone else gets "not found". */
  async function controllable(actor: Actor, examId: string): Promise<ExamRecord> {
    const exam = await exams.findById(examId);
    if (!exam || !(isAdmin(actor.role) || (actor.role === ROLES.TEACHER && exam.teacherId === actor.id))) throw new AppError('NOT_FOUND');
    return exam;
  }

  const log = (action: string, actor: Actor, ctx: Context, examId: string, metadata: Record<string, unknown>) =>
    recordSafely(audit, { action, actorId: actor.id, entityType: 'exam', entityId: examId, ip: ctx.ip, requestId: ctx.requestId, metadata });

  const secondsLeft = (endsAt: Date, at: Date): number => Math.max(0, Math.floor((endsAt.getTime() - at.getTime()) / 1000));

  return {
    async pause(actor: Actor, examId: string, input: { reason?: string | undefined }, ctx: Context) {
      const exam = await controllable(actor, examId);
      if (exam.status !== EXAM_STATUS.PUBLISHED) throw new AppError('CONFLICT', { message: 'Only a published exam can be paused' });
      if (exam.pausedAt) throw new AppError('CONFLICT', { message: 'This exam is already paused' });
      const reason = input.reason ? sanitizeText(input.reason) || null : null;

      const now = new Date();
      await withTransaction(async (session) => {
        if (!(await exams.pause(examId, now, reason, session))) throw new AppError('CONFLICT', { message: 'This exam cannot be paused. It may be paused already, or its window has closed' });
        await pauses.open(examId, now, actor.id, reason, session);
      });

      // Tell the owner when somebody else paused their exam.
      if (exam.teacherId !== actor.id) {
        await notifier.notify({
          userIds: [exam.teacherId], type: 'EXAM_PAUSED', title: 'Your exam was paused',
          body: `"${exam.title}" was paused${reason ? `: ${reason}` : '.'}`, data: { examId }, email: false,
        });
      }
      await log('EXAM_PAUSED', actor, ctx, examId, { reason });
      return { examId, paused: true, pausedAt: now.toISOString(), reason };
    },

    async resume(actor: Actor, examId: string, ctx: Context) {
      const exam = await controllable(actor, examId);
      if (!exam.pausedAt) throw new AppError('CONFLICT', { message: 'This exam is not paused' });
      const pausedAt = exam.pausedAt;
      const now = new Date();
      const pausedMs = Math.max(0, now.getTime() - pausedAt.getTime());

      const extended = await withTransaction(async (session) => {
        const resumed = await exams.resume(examId, pausedMs, session);
        if (!resumed) throw new AppError('CONFLICT', { message: 'This exam is not paused' });
        const count = await attempts.extendActive(examId, pausedAt, pausedMs, session);
        await pauses.close(examId, now, actor.id, pausedMs, session);
        return count;
      });

      // The delayed auto-submit jobs were set for the old end times. Set them again for the new ones.
      const running = await attempts.runningTimes(examId);
      for (let i = 0; i < running.length; i += RESCHEDULE_BATCH) {
        await Promise.all(running.slice(i, i + RESCHEDULE_BATCH).map(async (a) => {
          await scheduler.cancel(a.id);
          await scheduler.scheduleAutoSubmit(a.id, a.endsAt);
        }));
      }

      if (exam.teacherId !== actor.id) {
        await notifier.notify({
          userIds: [exam.teacherId], type: 'EXAM_RESUMED', title: 'Your exam was resumed',
          body: `"${exam.title}" is running again.`, data: { examId }, email: false,
        });
      }
      await log('EXAM_RESUMED', actor, ctx, examId, { pausedMs, attemptsExtended: extended });
      return { examId, paused: false, pausedMs, attemptsExtended: extended, windowEnd: new Date(exam.windowEnd.getTime() + pausedMs).toISOString() };
    },

    /**
     * Is the exam running or paused? A student's screen asks this to show the "temporarily paused" notice,
     * with the time they have left (frozen while paused). Staff see it for their own exams.
     */
    async status(actor: Actor, examId: string) {
      if (actor.role === ROLES.PARENT) throw new AppError('FORBIDDEN');
      const now = new Date();
      const exam = actor.role === ROLES.STUDENT ? await exams.findById(examId) : await controllable(actor, examId);
      if (!exam) throw new AppError('NOT_FOUND');

      let attempt: { id: string; status: 'IN_PROGRESS' | 'SUBMITTED'; remainingSeconds: number } | null = null;
      if (actor.role === ROLES.STUDENT) {
        const armId = (await enrolments.forStudents([actor.id], exam.sessionId)).get(actor.id)?.classArmId;
        if (exam.status !== EXAM_STATUS.PUBLISHED || !armId || !exam.classArmIds.includes(armId)) throw new AppError('NOT_FOUND');
        const mine = await attempts.findByExamStudent(examId, actor.id);
        if (mine) {
          attempt = {
            id: mine.id, status: mine.status,
            remainingSeconds: mine.status === ATTEMPT_STATUS.IN_PROGRESS ? secondsLeft(mine.endsAt, exam.pausedAt ?? now) : 0,
          };
        }
      }
      return {
        examId, paused: exam.pausedAt !== null, pausedAt: exam.pausedAt ? exam.pausedAt.toISOString() : null,
        reason: exam.pauseReason, windowEnd: exam.windowEnd.toISOString(), serverTime: now.toISOString(), attempt,
      };
    },

    async history(actor: Actor, examId: string) {
      await controllable(actor, examId);
      const rows = await pauses.list(examId);
      const names = await staff.nameMap(rows.flatMap((r) => (r.resumedBy ? [r.pausedBy, r.resumedBy] : [r.pausedBy])));
      return rows.map((r) => ({
        id: r.id, pausedAt: r.pausedAt.toISOString(), pausedBy: r.pausedBy, pausedByName: names.get(r.pausedBy) ?? '', reason: r.reason,
        resumedAt: r.resumedAt ? r.resumedAt.toISOString() : null, resumedBy: r.resumedBy, resumedByName: r.resumedBy ? (names.get(r.resumedBy) ?? '') : null,
        extendedSeconds: r.extendedMs === null ? null : Math.round(r.extendedMs / 1000),
      }));
    },
  };
}

export type PauseService = ReturnType<typeof createPauseService>;
