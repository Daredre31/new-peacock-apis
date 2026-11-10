import { randomBytes } from 'node:crypto';
import { AppError } from '../../common/errors/AppError';
import { detectImageType } from '../../common/utils/image';
import { logger } from '../../common/utils/logger';
import { normalizeEmail, normalizePhone } from '../../common/utils/identifier';
import { formatNaira } from '../../common/utils/money';
import { sanitizeText } from '../../common/utils/text';
import { ADMISSION_REFERENCE_PREFIX, ROLES, SCHOOL_NAME } from '../../config/constants';
import type { ImageStore } from '../../integrations/imageStore';
import type { Mailer } from '../../integrations/mailer';
import type { PaystackClient } from '../../integrations/paystack';
import type { enrolmentRepository } from '../academics/enrolment.repository';
import type { sessionRepository } from '../academics/session.repository';
import type { structureRepository } from '../academics/structure.repository';
import { recordSafely, type AuditPort } from '../audit/audit.port';
import type { NotificationService } from '../notifications/notification.service';
import type { LinkService } from '../users/link.service';
import type { ParentService } from '../users/parent.service';
import type { StudentService } from '../users/student.service';
import type { studentRepository } from '../users/student.repository';
import type { userRepository } from '../users/user.repository';
import {
  ADMISSION_STATUS, FEE_PAYMENT_STATUS, type AdmissionSettings, type AdmissionStatus, type ApplicationRecord,
  type applicationRepository,
} from './application.repository';

interface Actor { id: string }
interface Context { ip: string; requestId: string }
export type ConfirmOutcome = 'CONFIRMED' | 'ALREADY' | 'NOT_PAID_YET' | 'FAILED' | 'MISMATCH' | 'UNAVAILABLE' | 'UNKNOWN';

const fail = (field: string, issue: string): AppError => new AppError('VALIDATION_ERROR', { details: [{ field, issue }] });
const naira = (kobo: number): string => `NGN ${formatNaira(kobo)}`;
const REUSE_MS = 25 * 60_000;
const photoId = (applicationId: string): string => `peacock/admissions/${applicationId}`;
const passportId = (studentId: string): string => `peacock/students/${studentId}`;
const LOCK_MS = 2 * 60_000;

function ageOn(dateOfBirth: string, now: Date): number {
  const d = new Date(`${dateOfBirth}T00:00:00Z`);
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  if (now.getUTCMonth() < d.getUTCMonth() || (now.getUTCMonth() === d.getUTCMonth() && now.getUTCDate() < d.getUTCDate())) age -= 1;
  return age;
}

export function createAdmissionService(deps: {
  repo: typeof applicationRepository;
  paystack: Pick<PaystackClient, 'initialize' | 'verify' | 'isConfigured'>;
  mailer: Mailer;
  images: ImageStore;
  structure: Pick<typeof structureRepository, 'findClass' | 'findArm' | 'listClasses' | 'classesByIds' | 'armsByIds'>;
  sessions: Pick<typeof sessionRepository, 'findSession' | 'findCurrentSession'>;
  enrolments: Pick<typeof enrolmentRepository, 'forStudents'>;
  students: StudentService;
  studentRecords: Pick<typeof studentRepository, 'update'>;
  parents: ParentService;
  links: LinkService;
  users: Pick<typeof userRepository, 'findAuth' | 'findIdsByRoles'>;
  notifier: Pick<NotificationService, 'notify'>;
  returnUrl: string;
  audit: AuditPort;
  now?: () => Date;
}) {
  const { repo, paystack, mailer, images, structure, sessions, students, studentRecords, parents, links, users, notifier, audit } = deps;
  const clock = deps.now ?? ((): Date => new Date());

  const log = (action: string, actor: Actor | null, ctx: Context | null, id: string, metadata: Record<string, unknown>) =>
    recordSafely(audit, { action, ...(actor ? { actorId: actor.id } : {}), entityType: 'admissionApplication', entityId: id, ...(ctx ? { ip: ctx.ip, requestId: ctx.requestId } : {}), metadata });

  async function email(to: string, subject: string, text: string): Promise<void> {
    try { await mailer.send({ to, subject, text }); } catch (err) { logger.warn({ err: err instanceof Error ? err.message : 'error', subject }, 'admission email failed'); }
  }

  /** A parent proves it is theirs with the application number AND the email or phone they applied with. */
  async function mustOwn(applicationNo: string, contact: string): Promise<ApplicationRecord> {
    const app = await repo.findByNo(applicationNo.trim().toUpperCase());
    const em = normalizeEmail(contact);
    const ph = normalizePhone(contact);
    if (!app || !((em && em === app.parent.email) || (ph && ph === app.parent.phone))) throw new AppError('NOT_FOUND');
    return app;
  }

  const classNameOf = async (classId: string): Promise<string> => (await structure.findClass(classId))?.name ?? '';

  /** What the public sees. Nothing about other people, no payment references. */
  async function publicView(app: ApplicationRecord, extra: Record<string, unknown> = {}) {
    const pending = app.payments.find((p) => p.status === FEE_PAYMENT_STATUS.PENDING && p.checkoutUrl && Date.now() - p.createdAt.getTime() < REUSE_MS);
    return {
      applicationNo: app.applicationNo, status: app.status, childName: `${app.child.firstName} ${app.child.lastName}`, className: await classNameOf(app.child.classId),
      feeKobo: app.feeKobo, paid: app.paidAt !== null, photoUploaded: app.photoUrl !== null, canUploadPhoto: app.status === ADMISSION_STATUS.SUBMITTED,
      declineReason: app.status === ADMISSION_STATUS.DECLINED ? app.declineReason : null,
      checkoutUrl: app.status === ADMISSION_STATUS.PENDING_PAYMENT ? (pending?.checkoutUrl ?? null) : null, createdAt: app.createdAt.toISOString(), ...extra,
    };
  }

  async function startPayment(app: ApplicationRecord): Promise<string> {
    if (!paystack.isConfigured()) throw new AppError('SERVICE_UNAVAILABLE', { message: 'Online payment is not available yet. Your application is saved: please try again later.' });
    const open = app.payments.find((p) => p.status === FEE_PAYMENT_STATUS.PENDING && p.checkoutUrl && Date.now() - p.createdAt.getTime() < REUSE_MS);
    if (open?.checkoutUrl) return open.checkoutUrl;

    const reference = `${ADMISSION_REFERENCE_PREFIX}${randomBytes(10).toString('hex').toUpperCase()}`;
    await repo.addPayment(app.id, { reference, amountKobo: app.feeKobo, status: FEE_PAYMENT_STATUS.PENDING, checkoutUrl: null, createdAt: clock(), paidAt: null });
    const sep = deps.returnUrl.includes('?') ? '&' : '?';
    const result = await paystack.initialize({
      email: app.parent.email, amountKobo: app.feeKobo, reference, callbackUrl: `${deps.returnUrl}${sep}applicationNo=${encodeURIComponent(app.applicationNo)}`,
      metadata: { applicationNo: app.applicationNo, custom_fields: [{ display_name: 'Application', variable_name: 'application_no', value: app.applicationNo }] },
    });
    if (!result.ok || result.data.reference !== reference || !result.data.authorization_url.startsWith('https://')) {
      await repo.markPaymentFailed(reference);
      throw new AppError('SERVICE_UNAVAILABLE', { message: 'We could not start the payment. Nothing was charged. Your application is saved: please try again.' });
    }
    await repo.setCheckout(reference, result.data.authorization_url);
    return result.data.authorization_url;
  }

  /** Asks Paystack what really happened. Safe to call any number of times, from anywhere. */
  async function confirm(reference: string, options: { throttleMs?: number } = {}): Promise<ConfirmOutcome> {
    const app = await repo.findByPaymentReference(reference);
    const payment = app?.payments.find((p) => p.reference === reference);
    if (!app || !payment) return 'UNKNOWN';
    if (payment.status === FEE_PAYMENT_STATUS.SUCCESS) return 'ALREADY';
    if (options.throttleMs !== undefined && !(await repo.claimVerify(reference, options.throttleMs, clock()))) return 'NOT_PAID_YET';

    const verified = await paystack.verify(reference);
    if (!verified.ok) return verified.kind === 'NOT_FOUND' ? 'NOT_PAID_YET' : 'UNAVAILABLE';
    const tx = verified.data;
    if (tx.reference !== reference) return 'MISMATCH';
    if (tx.status === 'failed' || tx.status === 'reversed') { await repo.markPaymentFailed(reference); return 'FAILED'; }
    if (tx.status !== 'success') return 'NOT_PAID_YET';

    if (!Number.isSafeInteger(tx.amount) || tx.amount !== payment.amountKobo || tx.currency !== 'NGN') {
      await notifier.notify({
        userIds: await users.findIdsByRoles([ROLES.SUPER_ADMIN, ROLES.ADMIN]), type: 'PAYMENT_ALERT', title: 'An admission payment needs review',
        body: `Application ${app.applicationNo}: expected ${naira(payment.amountKobo)} but Paystack reports ${tx.amount} ${tx.currency}. The application was not marked as paid.`, data: { applicationId: app.id }, email: true,
      });
      await log('ADMISSION_PAYMENT_MISMATCH', null, null, app.id, { reference, expectedKobo: payment.amountKobo, gotKobo: tx.amount, currency: tx.currency });
      return 'MISMATCH';
    }

    const outcome = await repo.confirmPayment(reference, tx.paid_at ? new Date(tx.paid_at) : clock());
    if (outcome === 'ALREADY') return 'ALREADY';
    if (outcome === 'EXTRA') {
      // Paid twice. The money is real, so staff must refund the second payment in Paystack.
      await notifier.notify({
        userIds: await users.findIdsByRoles([ROLES.SUPER_ADMIN, ROLES.ADMIN]), type: 'PAYMENT_ALERT', title: 'An application fee was paid twice',
        body: `Application ${app.applicationNo} was paid twice (${reference}). Please refund the extra payment in the Paystack dashboard.`, data: { applicationId: app.id }, email: true,
      });
      await log('ADMISSION_PAYMENT_DUPLICATE', null, null, app.id, { reference });
      return 'CONFIRMED';
    }
    await log('ADMISSION_PAID', null, null, app.id, { reference, amountKobo: payment.amountKobo });
    await email(
      app.parent.email, `${SCHOOL_NAME}: application received (${app.applicationNo})`,
      `Dear ${app.parent.firstName},\n\nThank you. We received the application fee of ${naira(payment.amountKobo)} for ${app.child.firstName} ${app.child.lastName}.\n\n` +
        `Your application number is ${app.applicationNo}. Please keep it.\n\nNext step: upload ${app.child.firstName}'s passport photograph on the application status page, using this application number and the email or phone number you applied with. ` +
        `The school will review the application and contact you.\n\nThe application fee is not refundable.\n\n${SCHOOL_NAME}`,
    );
    await notifier.notify({
      userIds: await users.findIdsByRoles([ROLES.ADMIN]), type: 'ADMISSION_SUBMITTED', title: 'New admission application',
      body: `${app.child.firstName} ${app.child.lastName} (${app.applicationNo}) has applied and paid.`, data: { applicationId: app.id }, email: false,
    });
    return 'CONFIRMED';
  }

  async function adminView(app: ApplicationRecord) {
    const className = await classNameOf(app.child.classId);
    return {
      id: app.id, applicationNo: app.applicationNo, status: app.status, child: { ...app.child, className }, parent: app.parent, feeKobo: app.feeKobo,
      paid: app.paidAt !== null, paidAt: app.paidAt ? app.paidAt.toISOString() : null, photoUrl: app.photoUrl, declineReason: app.declineReason,
      decidedAt: app.decidedAt ? app.decidedAt.toISOString() : null, studentId: app.studentId, parentUserId: app.parentUserId, createdAt: app.createdAt.toISOString(),
      payments: app.payments.map((p) => ({ reference: p.reference, amountKobo: p.amountKobo, status: p.status, paidAt: p.paidAt ? p.paidAt.toISOString() : null, createdAt: p.createdAt.toISOString() })),
    };
  }
  async function mustFind(id: string): Promise<ApplicationRecord> {
    const app = await repo.findById(id);
    if (!app) throw new AppError('NOT_FOUND');
    return app;
  }

  return {
    confirm,

    /** For the public form: is it open, what does it cost, which classes can be chosen. */
    async info() {
      const settings = await repo.getSettings();
      const { items } = await structure.listClasses({}, { page: 1, limit: 100, sort: 'level' });
      return { open: settings.open, feeKobo: settings.feeKobo, classes: items.map((c) => ({ id: c.id, name: c.name })) };
    },

    async apply(
      input: {
        childFirstName: string; childMiddleName?: string | undefined; childLastName: string; gender: 'MALE' | 'FEMALE'; dateOfBirth: string; classId: string;
        previousSchool?: string | undefined; address?: string | undefined; parentFirstName: string; parentLastName: string; parentEmail: string;
        parentPhone: string; relationship: 'FATHER' | 'MOTHER' | 'GUARDIAN' | 'OTHER'; website?: string | undefined;
      },
      ctx: Context,
    ) {
      if (input.website) throw fail('website', 'Not allowed'); // a hidden field only bots fill in
      const settings = await repo.getSettings();
      if (!settings.open) throw new AppError('CONFLICT', { message: 'Admissions are closed at the moment' });
      const parentEmail = normalizeEmail(input.parentEmail);
      if (!parentEmail) throw fail('parentEmail', 'Enter a valid email address');
      const parentPhone = normalizePhone(input.parentPhone);
      if (!parentPhone) throw fail('parentPhone', 'Enter a valid phone number');
      const age = ageOn(input.dateOfBirth, clock());
      if (age < 1 || age > 25) throw fail('dateOfBirth', 'Check the date of birth');
      if (!(await structure.findClass(input.classId))) throw fail('classId', 'Choose a class from the list');

      const firstName = sanitizeText(input.childFirstName);
      const lastName = sanitizeText(input.childLastName);
      const existing = await repo.findDuplicate(parentEmail, firstName, lastName, input.dateOfBirth);
      let app = existing;
      if (existing && existing.status !== ADMISSION_STATUS.PENDING_PAYMENT) {
        throw new AppError('CONFLICT', { message: `An application for this child already exists (${existing.applicationNo}). Use the status page to follow it.` });
      }
      if (!app) {
        app = await repo.create(
          {
            child: {
              firstName, middleName: input.childMiddleName ? sanitizeText(input.childMiddleName) : null, lastName, gender: input.gender, dateOfBirth: input.dateOfBirth,
              classId: input.classId, previousSchool: input.previousSchool ? sanitizeText(input.previousSchool) : null, address: input.address ? sanitizeText(input.address) : null,
            },
            parent: { firstName: sanitizeText(input.parentFirstName), lastName: sanitizeText(input.parentLastName), email: parentEmail, phone: parentPhone, relationship: input.relationship, address: null },
            feeKobo: settings.feeKobo,
          },
          clock(),
        );
        await log('ADMISSION_APPLIED', null, ctx, app.id, { applicationNo: app.applicationNo, classId: input.classId });
      }
      // If the payment cannot be started the application is still saved, and the parent can start it again.
      let checkoutUrl: string | null = null;
      let message: string | null = null;
      try { checkoutUrl = await startPayment(app); } catch (err) { message = err instanceof AppError ? (err.message) : 'We could not start the payment'; }
      return { applicationNo: app.applicationNo, status: app.status, feeKobo: app.feeKobo, checkoutUrl, message };
    },

    /** The "pay" button again: for a payment that was never started, expired or failed. */
    async pay(input: { applicationNo: string; contact: string }) {
      const app = await mustOwn(input.applicationNo, input.contact);
      if (app.status !== ADMISSION_STATUS.PENDING_PAYMENT) throw new AppError('CONFLICT', { message: 'The fee for this application was already paid' });
      return { applicationNo: app.applicationNo, feeKobo: app.feeKobo, checkoutUrl: await startPayment(app) };
    },

    async status(input: { applicationNo: string; contact: string }) {
      let app = await mustOwn(input.applicationNo, input.contact);
      if (app.status === ADMISSION_STATUS.PENDING_PAYMENT) {
        for (const p of app.payments.filter((x) => x.status === FEE_PAYMENT_STATUS.PENDING)) await confirm(p.reference, { throttleMs: 10_000 });
        app = (await repo.findByNo(app.applicationNo)) ?? app;
      }
      return publicView(app);
    },

    async uploadPhoto(input: { applicationNo: string; contact: string; image: Buffer }) {
      const app = await mustOwn(input.applicationNo, input.contact);
      if (app.status !== ADMISSION_STATUS.SUBMITTED) throw new AppError('CONFLICT', { message: app.status === ADMISSION_STATUS.PENDING_PAYMENT ? 'Pay the application fee first, then upload the photo' : 'This application can no longer be changed' });
      if (!detectImageType(input.image)) throw fail('file', 'The file must be a JPEG, PNG or WebP image');
      const stored = await images.upload(input.image, photoId(app.id));
      if (!(await repo.setPhoto(app.id, photoId(app.id), stored.url))) throw new AppError('CONFLICT', { message: 'This application can no longer be changed' });
      await log('ADMISSION_PHOTO_UPLOADED', null, null, app.id, {});
      return publicView((await repo.findByNo(app.applicationNo)) ?? app);
    },

    // ---------------- staff ----------------
    async list(input: { page: number; limit: number; status?: AdmissionStatus | undefined; q?: string | undefined }) {
      const { page, limit, ...filter } = input;
      const { items, total } = await repo.list(filter, { page, limit });
      return { items: await Promise.all(items.map(adminView)), total };
    },
    async get(id: string) { return adminView(await mustFind(id)); },

    /** "The parent says they paid": checks every open payment with Paystack right now. */
    async recheckPayment(actor: Actor, id: string, ctx: Context) {
      const app = await mustFind(id);
      const outcomes: ConfirmOutcome[] = [];
      for (const p of app.payments.filter((x) => x.status !== FEE_PAYMENT_STATUS.SUCCESS)) outcomes.push(await confirm(p.reference));
      await log('ADMISSION_PAYMENT_RECHECKED', actor, ctx, id, { outcomes });
      return { application: await adminView((await repo.findById(id)) ?? app), outcomes };
    },

    async decline(actor: Actor, id: string, reason: string, ctx: Context) {
      await mustFind(id);
      const declined = await repo.decline(id, actor.id, sanitizeText(reason), clock());
      if (!declined) throw new AppError('CONFLICT', { message: 'Only a paid application that is still waiting can be declined' });
      await log('ADMISSION_DECLINED', actor, ctx, id, { reason: declined.declineReason });
      await email(
        declined.parent.email, `${SCHOOL_NAME}: update on application ${declined.applicationNo}`,
        `Dear ${declined.parent.firstName},\n\nThank you for applying to ${SCHOOL_NAME}. After review, we are unable to offer ${declined.child.firstName} a place at this time.\n\n` +
          `Reason: ${declined.declineReason ?? 'not given'}\n\nIf you have questions, please contact the school office.\n\n${SCHOOL_NAME}`,
      );
      return adminView(declined);
    },

    /**
     * Turns an application into a real student and parent, using the same code as the admin screens.
     * If it stops half way, running it again carries on from where it stopped.
     */
    async accept(actor: Actor, id: string, input: { classArmId: string; sessionId?: string | undefined }, ctx: Context) {
      const existing = await mustFind(id);
      if (existing.status === ADMISSION_STATUS.ACCEPTED) throw new AppError('CONFLICT', { message: 'This application was already accepted' });
      if (existing.status !== ADMISSION_STATUS.SUBMITTED) throw new AppError('CONFLICT', { message: 'Only a paid application can be accepted' });
      const arm = await structure.findArm(input.classArmId);
      if (!arm) throw fail('classArmId', 'Class arm not found');
      const session = input.sessionId ? await sessions.findSession(input.sessionId) : await sessions.findCurrentSession();
      if (!session) throw fail('sessionId', input.sessionId ? 'Session not found' : 'There is no current session yet');

      const now = clock();
      const app = await repo.claimAccept(id, now, new Date(now.getTime() - LOCK_MS));
      if (!app) throw new AppError('CONFLICT', { message: 'This application is being processed. Try again in a minute.' });

      try {
        // 1. the parent (or the existing account, when this family is already in the school)
        let parentUserId = app.parentUserId;
        let parentTemporaryPassword: string | null = null;
        let parentAlreadyExisted = false;
        if (!parentUserId) {
          const found = (await users.findAuth({ email: app.parent.email })) ?? (await users.findAuth({ phone: app.parent.phone }));
          if (found) {
            if (found.role !== ROLES.PARENT) throw new AppError('CONFLICT', { message: 'The parent email or phone already belongs to a staff or student account. Fix it before accepting.' });
            parentUserId = found.id;
            parentAlreadyExisted = true;
          } else {
            const created = await parents.create(
              { firstName: app.parent.firstName, lastName: app.parent.lastName, email: app.parent.email, phone: app.parent.phone, delivery: 'EMAIL_INVITE' },
              actor, ctx,
            );
            parentUserId = created.account.id;
            parentTemporaryPassword = created.temporaryPassword;
          }
          await repo.saveProgress(id, { parentUserId });
        }

        // 2. the student
        let studentId = app.studentId;
        let admissionNo: string | null = null;
        let studentTemporaryPassword: string | null = null;
        if (!studentId) {
          const created = await students.create(
            {
              firstName: app.child.firstName, ...(app.child.middleName ? { middleName: app.child.middleName } : {}), lastName: app.child.lastName, gender: app.child.gender,
              dateOfBirth: app.child.dateOfBirth, ...(app.child.address ? { address: app.child.address } : {}), admissionSessionId: session.id, classArmId: arm.id, delivery: 'TEMPORARY_PASSWORD',
            },
            actor, ctx,
          );
          studentId = created.account.id;
          admissionNo = created.account.admissionNo;
          studentTemporaryPassword = created.temporaryPassword;
          await repo.saveProgress(id, { studentId });
        } else {
          admissionNo = (await students.viewsByUserIds([studentId]))[0]?.admissionNo ?? null;
        }

        // 3. link them
        try { await links.link(parentUserId, { studentId, relationship: app.parent.relationship }, actor, ctx); } catch (err) {
          if (!(err instanceof AppError && err.code === 'CONFLICT')) throw err; // already linked is fine
        }

        // 4. the photo becomes the passport. A problem here never blocks the admission.
        let passport: 'SET' | 'FAILED' | 'NONE' = 'NONE';
        if (app.photoPublicId) {
          try {
            const moved = await images.promote(app.photoPublicId, passportId(studentId));
            await studentRecords.update(studentId, { passportUrl: moved.url });
            passport = 'SET';
          } catch (err) {
            passport = 'FAILED';
            logger.warn({ err: err instanceof Error ? err.message : 'error', applicationId: id }, 'could not set the admission photo as passport');
          }
        }

        const done = await repo.finishAccept(id, actor.id, clock());
        if (!done) throw new AppError('CONFLICT', { message: 'This application changed while it was being accepted' });
        await log('ADMISSION_ACCEPTED', actor, ctx, id, { studentId, parentUserId, classArmId: arm.id, sessionId: session.id, passport, parentAlreadyExisted });
        await email(
          app.parent.email, `${SCHOOL_NAME}: ${app.child.firstName} has been admitted`,
          `Dear ${app.parent.firstName},\n\nCongratulations! ${app.child.firstName} ${app.child.lastName} has been offered a place at ${SCHOOL_NAME}.\n\n` +
            `${admissionNo ? `Admission number: ${admissionNo}\n` : ''}` +
            (parentAlreadyExisted
              ? 'Your child has been added to your existing parent account. Please log in to see the details.\n'
              : 'You will receive a separate email to set up your parent account. Use it to follow your child\'s fees, results and notices.\n') +
            `\nThe school office will give you the remaining admission details.\n\n${SCHOOL_NAME}`,
        );
        return {
          studentId, admissionNo, studentTemporaryPassword, parentUserId, parentAlreadyExisted, parentTemporaryPassword, passport,
          note: studentTemporaryPassword === null && admissionNo ? 'Resumed an earlier attempt. If the student has no password, reset it from the student screen.' : null,
        };
      } catch (err) {
        await repo.releaseAccept(id);
        throw err;
      }
    },

    getSettings: (): Promise<AdmissionSettings> => repo.getSettings(),
    async updateSettings(actor: Actor, patch: Partial<AdmissionSettings>, ctx: Context): Promise<AdmissionSettings> {
      const before = await repo.getSettings();
      const after = await repo.updateSettings(patch);
      await log('ADMISSION_SETTINGS_CHANGED', actor, ctx, 'settings', { before, after });
      return after;
    },
  };
}

export type AdmissionService = ReturnType<typeof createAdmissionService>;
