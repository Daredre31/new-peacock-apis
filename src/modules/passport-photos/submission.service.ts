import { AppError } from '../../common/errors/AppError';
import { logger } from '../../common/utils/logger';
import { ROLES } from '../../config/constants';
import type { ImageStore } from '../../integrations/imageStore';
import { recordSafely, type AuditPort } from '../audit/audit.port';
import type { NotificationService } from '../notifications/notification.service';
import type { linkRepository } from '../users/link.repository';
import { STUDENT_STATUS } from '../users/student.model';
import type { studentRepository } from '../users/student.repository';
import type { SubmissionStatus, UploaderRole } from './submission.model';
import type { SubmissionRecord, submissionRepository } from './submission.repository';

interface Actor { id: string; role: string }
interface Context { ip: string; requestId: string }

/** Where a proposed photo waits. One fixed id per student, so a new upload replaces the old proposal. */
const pendingPublicId = (studentId: string): string => `peacock/students-pending/${studentId}`;
/** The approved passport. Must match the id the admin upload uses (student.service.ts). */
const passportPublicId = (studentId: string): string => `peacock/students/${studentId}`;

export interface SubmissionView {
  studentId: string;
  status: SubmissionStatus | 'NONE';
  /** The proposed photo. Null when nothing was proposed, or it was rejected and removed. */
  photoUrl: string | null;
  reason: string | null;
  uploaderRole: UploaderRole | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  /** The approved passport that report cards use right now. */
  passportUrl: string | null;
}

export interface QueueItem extends SubmissionView {
  name: string;
  admissionNo: string;
}

export type BulkResult = { studentId: string; ok: true } | { studentId: string; ok: false; code: string };

export function createPassportPhotoService(deps: {
  repo: typeof submissionRepository;
  students: Pick<typeof studentRepository, 'findByUserId' | 'findManyByUserIds' | 'update' | 'profileMap'>;
  links: Pick<typeof linkRepository, 'activeParentIdsOf'>;
  images: ImageStore;
  notifier: Pick<NotificationService, 'notify'>;
  audit: AuditPort;
}) {
  const { repo, students, links, images, notifier, audit } = deps;

  const toView = (studentId: string, rec: SubmissionRecord | null, passportUrl: string | null): SubmissionView => ({
    studentId,
    status: rec?.status ?? 'NONE',
    photoUrl: rec?.url ?? null,
    reason: rec?.reason ?? null,
    uploaderRole: rec?.uploaderRole ?? null,
    submittedAt: rec?.submittedAt.toISOString() ?? null,
    reviewedAt: rec?.reviewedAt?.toISOString() ?? null,
    passportUrl,
  });

  const log = (event: string, actor: Actor, ctx: Context, studentId: string, after: Record<string, unknown>) =>
    recordSafely(audit, { action: `PASSPORT_PHOTO_${event}`, actorId: actor.id, entityType: 'user', entityId: studentId, ip: ctx.ip, requestId: ctx.requestId, after });

  async function mustFindStudent(studentId: string) {
    const student = await students.findByUserId(studentId);
    if (!student) throw new AppError('NOT_FOUND');
    return student;
  }

  async function tell(studentId: string, type: string, title: string, body: string): Promise<void> {
    const parents = await links.activeParentIdsOf([studentId]);
    await notifier.notify({ userIds: [studentId, ...parents], type, title, body, data: { studentId } });
  }

  return {
    /** A student for themselves, or a parent for a linked child. The caller has already checked who may reach this student. */
    async submit(actor: Actor, studentId: string, image: Buffer, ctx: Context): Promise<SubmissionView> {
      const student = await mustFindStudent(studentId);
      if (student.status !== STUDENT_STATUS.ACTIVE) throw new AppError('NOT_FOUND');
      const uploaderRole: UploaderRole = actor.role === ROLES.PARENT ? 'PARENT' : 'STUDENT';

      const stored = await images.upload(image, pendingPublicId(studentId));
      const rec = await repo.savePending({ studentId, uploadedBy: actor.id, uploaderRole, url: stored.url, now: new Date() });
      await log('SUBMITTED', actor, ctx, studentId, { uploaderRole });
      return toView(studentId, rec, student.passportUrl);
    },

    async get(studentId: string): Promise<SubmissionView> {
      const student = await mustFindStudent(studentId);
      return toView(studentId, await repo.find(studentId), student.passportUrl);
    },

    /** The admin's queue, oldest first. */
    async list(status: SubmissionStatus, page: number, limit: number): Promise<{ items: QueueItem[]; total: number }> {
      const { items, total } = await repo.list(status, { page, limit });
      const ids = items.map((i) => i.studentId);
      const [profiles, records] = await Promise.all([students.profileMap(ids), students.findManyByUserIds(ids)]);
      const passports = new Map(records.map((r) => [r.userId, r.passportUrl]));
      return {
        items: items.map((rec) => ({
          ...toView(rec.studentId, rec, passports.get(rec.studentId) ?? null),
          name: profiles.get(rec.studentId)?.name ?? '',
          admissionNo: profiles.get(rec.studentId)?.admissionNo ?? '',
        })),
        total,
      };
    },

    async approve(studentId: string, admin: Actor, ctx: Context): Promise<SubmissionView> {
      await mustFindStudent(studentId);
      const claimed = await repo.decide(studentId, 'APPROVED', admin.id, { now: new Date() });
      if (!claimed) {
        throw (await repo.find(studentId))
          ? new AppError('CONFLICT', { message: 'This photo is not waiting for approval' })
          : new AppError('NOT_FOUND');
      }

      let passportUrl: string;
      try {
        // The approved photo gets its own id, so a later upload by the family can never change what report cards show.
        passportUrl = (await images.promote(pendingPublicId(studentId), passportPublicId(studentId))).url;
      } catch (err) {
        await repo.reopen(studentId, claimed.url ?? '');
        throw err;
      }
      try {
        await students.update(studentId, { passportUrl });
      } catch {
        await students.update(studentId, { passportUrl }); // one retry: the image is already live, so finish the job
      }
      await repo.setUrl(studentId, passportUrl);

      await log('APPROVED', admin, ctx, studentId, { passportUrl, uploaderRole: claimed.uploaderRole });
      await tell(studentId, 'PASSPORT_APPROVED', 'Passport photo approved', 'The school approved the passport photo. It now appears on the student record.');
      return toView(studentId, { ...claimed, url: passportUrl }, passportUrl);
    },

    async reject(studentId: string, reason: string, admin: Actor, ctx: Context): Promise<SubmissionView> {
      const student = await mustFindStudent(studentId);
      const claimed = await repo.decide(studentId, 'REJECTED', admin.id, { reason, url: null, now: new Date() });
      if (!claimed) {
        throw (await repo.find(studentId))
          ? new AppError('CONFLICT', { message: 'This photo is not waiting for approval' })
          : new AppError('NOT_FOUND');
      }
      // The rejected picture is not needed any more. A failure here only leaves a stray file, so it must not fail the rejection.
      await images.remove(pendingPublicId(studentId)).catch((err: unknown) => logger.warn({ err }, 'could not remove a rejected passport photo'));

      await log('REJECTED', admin, ctx, studentId, { reason });
      await tell(studentId, 'PASSPORT_REJECTED', 'Passport photo not accepted', `Please upload another photo. Reason: ${reason}`);
      return toView(studentId, claimed, student.passportUrl);
    },

    /** Approves many in one request. One failure does not stop the others. */
    async approveMany(studentIds: string[], admin: Actor, ctx: Context): Promise<BulkResult[]> {
      const results: BulkResult[] = [];
      for (const studentId of [...new Set(studentIds)]) {
        try {
          await this.approve(studentId, admin, ctx);
          results.push({ studentId, ok: true });
        } catch (err) {
          results.push({ studentId, ok: false, code: err instanceof AppError ? err.code : 'INTERNAL_ERROR' });
        }
      }
      return results;
    },
  };
}

export type PassportPhotoService = ReturnType<typeof createPassportPhotoService>;
