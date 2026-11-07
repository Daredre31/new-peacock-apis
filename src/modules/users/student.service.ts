import { AppError } from '../../common/errors/AppError';
import { normalizeEmail, normalizePhone } from '../../common/utils/identifier';
import { ROLES, USER_STATUS, type Role } from '../../config/constants';
import { withTransaction } from '../../config/db';
import type { EnrolmentRecord, enrolmentRepository } from '../academics/enrolment.repository';
import type { sessionRepository } from '../academics/session.repository';
import type { structureRepository } from '../academics/structure.repository';
import type { ImageStore } from '../../integrations/imageStore';
import { recordSafely, type AuditPort } from '../audit/audit.port';
import type { CredentialsService } from '../auth/credentials.service';
import type { PasswordService } from '../auth/password.service';
import type { TokenService } from '../auth/token.service';
import type { Gender } from './staff.model';
import type { StudentStatus } from './student.model';
import type { StudentRecord, StudentSort, studentRepository } from './student.repository';
import type { UserRecord, userRepository } from './user.repository';

interface Actor { id: string }
interface Context { ip: string; requestId: string }

export interface CreateStudentInput {
  firstName: string;
  middleName?: string | undefined;
  lastName: string;
  gender?: Gender | undefined;
  dateOfBirth?: string | undefined;
  address?: string | undefined;
  email?: string | undefined;
  phone?: string | undefined;
  admissionSessionId?: string | undefined;
  classArmId?: string | undefined;
  delivery: 'TEMPORARY_PASSWORD' | 'EMAIL_INVITE';
}
export type UpdateStudentInput = Partial<Omit<CreateStudentInput, 'delivery' | 'admissionSessionId' | 'classArmId' | 'middleName'>> & {
  /** null clears it. */
  middleName?: string | null | undefined;
  status?: StudentStatus | undefined;
};

export interface StudentServiceDeps {
  users: Pick<typeof userRepository, 'create' | 'findById' | 'findManyByIds' | 'updateContact' | 'softDelete'>;
  students: typeof studentRepository;
  enrolments: Pick<typeof enrolmentRepository, 'upsert' | 'forStudents' | 'studentIdsInArms'>;
  sessions: Pick<typeof sessionRepository, 'findSession' | 'findCurrentSession'>;
  structure: Pick<typeof structureRepository, 'findArm' | 'armsByIds' | 'classesByIds'>;
  passwords: Pick<PasswordService, 'generateTemporaryPassword' | 'hashPassword'>;
  credentials: Pick<CredentialsService, 'issueInvite'>;
  tokens: Pick<TokenService, 'revokeAllSessions'>;
  audit: AuditPort;
  images: ImageStore;
  /** The school setting: must a new student change the temporary password at first login? */
  forcePasswordChange: () => Promise<boolean>;
  /** Class arms this teacher teaches or is class teacher of, this session. */
  teacherArmIds: (teacherUserId: string) => Promise<string[]>;
}

/** One fixed Cloudinary id per student: uploading again replaces the old photo in place. */
const passportPublicId = (userId: string): string => `peacock/students/${userId}`;

interface EnrolmentView { sessionId: string; classArmId: string; classArmName: string }

const fail = (field: string, issue: string): AppError =>
  new AppError('VALIDATION_ERROR', { details: [{ field, issue }] });

function toView(s: StudentRecord, user: UserRecord, enrolment: EnrolmentView | null) {
  return {
    id: user.id,
    admissionNo: s.admissionNo,
    firstName: s.firstName,
    middleName: s.middleName,
    lastName: s.lastName,
    gender: s.gender,
    dateOfBirth: s.dateOfBirth ? s.dateOfBirth.toISOString().slice(0, 10) : null,
    address: s.address,
    passportUrl: s.passportUrl,
    status: s.status,
    admissionSessionId: s.admissionSessionId,
    enrolment,
    email: user.email,
    phone: user.phone,
    mustChangePassword: user.mustChangePassword,
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
    createdAt: user.createdAt.toISOString(),
  };
}
export type StudentView = ReturnType<typeof toView>;

function parseBirthDate(value: string): Date {
  const date = new Date(value);
  if (date > new Date()) throw fail('dateOfBirth', 'Cannot be in the future');
  return date;
}

export function createStudentService(deps: StudentServiceDeps) {
  const { users, students, enrolments, sessions, structure, passwords, credentials, tokens, audit } = deps;

  const log = (event: string, actor: Actor, ctx: Context, id: string, before: object | null, after: object | null) =>
    recordSafely(audit, {
      action: `STUDENT_${event}`, actorId: actor.id, entityType: 'user', entityId: id, ip: ctx.ip, requestId: ctx.requestId,
      before: before as Record<string, unknown> | null, after: after as Record<string, unknown> | null,
    });

  /** Joins in the user account and the current class, for a whole batch at once. */
  async function viewsOf(records: StudentRecord[]): Promise<StudentView[]> {
    const [userList, current] = await Promise.all([
      users.findManyByIds(records.map((r) => r.userId)),
      sessions.findCurrentSession(),
    ]);
    const userMap = new Map(userList.map((u) => [u.id, u]));
    const enrolled: Map<string, EnrolmentRecord> = current
      ? await enrolments.forStudents(records.map((r) => r.userId), current.id)
      : new Map();
    const arms = await structure.armsByIds([...enrolled.values()].map((e) => e.classArmId));
    const classes = await structure.classesByIds([...arms.values()].map((a) => a.classId));

    return records.flatMap((record) => {
      const user = userMap.get(record.userId);
      if (!user) return [];
      const e = enrolled.get(record.userId);
      const arm = e ? arms.get(e.classArmId) : undefined;
      const className = arm ? (classes.get(arm.classId)?.name ?? '') : '';
      const enrolment = e && arm ? { sessionId: e.sessionId, classArmId: arm.id, classArmName: `${className} ${arm.name}`.trim() } : null;
      return [toView(record, user, enrolment)];
    });
  }

  async function mustGet(userId: string): Promise<StudentView> {
    const record = await students.findByUserId(userId);
    const [view] = record ? await viewsOf([record]) : [];
    if (!view) throw new AppError('NOT_FOUND');
    return view;
  }

  return {
    async list(
      actor: { id: string; role: Role },
      input: { page: number; limit: number; sort: StudentSort; q?: string | undefined; status?: StudentStatus | undefined; classArmId?: string | undefined },
    ) {
      const current = await sessions.findCurrentSession();
      let userIds: string[] | undefined;

      if (actor.role === ROLES.TEACHER) {
        // A teacher only ever sees students in classes they teach.
        const own = await deps.teacherArmIds(actor.id);
        const arms = input.classArmId ? own.filter((id) => id === input.classArmId) : own;
        userIds = current ? await enrolments.studentIdsInArms(arms, current.id) : [];
      } else if (input.classArmId) {
        userIds = current ? await enrolments.studentIdsInArms([input.classArmId], current.id) : [];
      }

      const { items, total } = await students.list(
        { q: input.q, status: input.status, userIds },
        { page: input.page, limit: input.limit, sort: input.sort },
      );
      return { items: await viewsOf(items), total };
    },

    get: mustGet,

    /** Used by the parent portal and the link service. */
    async viewsByUserIds(ids: string[]): Promise<StudentView[]> {
      return viewsOf(await students.findManyByUserIds(ids));
    },

    async create(input: CreateStudentInput, actor: Actor, ctx: Context) {
      const email = input.email !== undefined ? normalizeEmail(input.email) : undefined;
      if (input.email !== undefined && !email) throw fail('email', 'Invalid email address');
      const phone = input.phone !== undefined ? normalizePhone(input.phone) : undefined;
      if (input.phone !== undefined && !phone) throw fail('phone', 'Invalid phone number');
      if (input.delivery === 'EMAIL_INVITE' && !email) throw fail('email', 'An email address is required to send an invite');
      const dateOfBirth = input.dateOfBirth !== undefined ? parseBirthDate(input.dateOfBirth) : undefined;

      const session = input.admissionSessionId
        ? await sessions.findSession(input.admissionSessionId)
        : await sessions.findCurrentSession();
      if (!session) {
        throw fail('admissionSessionId', input.admissionSessionId ? 'Session not found' : 'There is no current session yet. Create one and set a current term first');
      }
      const arm = input.classArmId ? await structure.findArm(input.classArmId) : null;
      if (input.classArmId && !arm) throw fail('classArmId', 'Class arm not found');

      const useTemporary = input.delivery === 'TEMPORARY_PASSWORD';
      const mustChangePassword = useTemporary && (await deps.forcePasswordChange());
      const temporaryPassword = useTemporary ? passwords.generateTemporaryPassword() : null;
      const passwordHash = temporaryPassword ? await passwords.hashPassword(temporaryPassword) : undefined;
      const profile = {
        firstName: input.firstName,
        ...(input.middleName ? { middleName: input.middleName } : {}),
        lastName: input.lastName,
        ...(input.gender ? { gender: input.gender } : {}),
        ...(dateOfBirth ? { dateOfBirth } : {}),
        ...(input.address ? { address: input.address } : {}),
      };

      // Login, student record, registration number and class are created together or not at all.
      const { user, student } = await withTransaction(async (tx) => {
        const created = await users.create(
          {
            ...(email ? { email } : {}),
            ...(phone ? { phone } : {}),
            ...(passwordHash ? { passwordHash } : {}),
            role: ROLES.STUDENT,
            status: useTemporary ? USER_STATUS.ACTIVE : USER_STATUS.INVITED,
            mustChangePassword,
          },
          new Date(),
          tx,
        );
        const record = await students.create(
          { userId: created.id, admissionSessionId: session.id, year: session.startDate.getUTCFullYear(), profile },
          tx,
        );
        if (arm) await enrolments.upsert(created.id, session.id, arm.id, tx);
        return { user: created, student: record };
      });

      const [view] = await viewsOf([student]);
      if (!view) throw new Error('Student view could not be built');
      const inviteEmailSent =
        !useTemporary && email ? await credentials.issueInvite({ userId: user.id, email, name: input.firstName }) : null;

      await log('CREATED', actor, ctx, user.id, null, view);
      return { account: view, temporaryPassword, inviteEmailSent };
    },

    async update(userId: string, patch: UpdateStudentInput, actor: Actor, ctx: Context): Promise<StudentView> {
      if (Object.values(patch).every((v) => v === undefined)) throw fail('body', 'Nothing to update');
      const before = await mustGet(userId);
      const current = await users.findById(userId);
      if (!current) throw new AppError('NOT_FOUND');

      const email = patch.email !== undefined ? normalizeEmail(patch.email) : undefined;
      if (patch.email !== undefined && !email) throw fail('email', 'Invalid email address');
      const phone = patch.phone !== undefined ? normalizePhone(patch.phone) : undefined;
      if (patch.phone !== undefined && !phone) throw fail('phone', 'Invalid phone number');

      const contact = {
        ...(email && email !== current.email ? { email } : {}),
        ...(phone && phone !== current.phone ? { phone } : {}),
      };
      const profile = {
        ...(patch.firstName !== undefined ? { firstName: patch.firstName } : {}),
        ...(patch.middleName !== undefined ? { middleName: patch.middleName } : {}),
        ...(patch.lastName !== undefined ? { lastName: patch.lastName } : {}),
        ...(patch.gender !== undefined ? { gender: patch.gender } : {}),
        ...(patch.dateOfBirth !== undefined ? { dateOfBirth: parseBirthDate(patch.dateOfBirth) } : {}),
        ...(patch.address !== undefined ? { address: patch.address } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
      };

      await withTransaction(async (tx) => {
        if (Object.keys(contact).length > 0 && !(await users.updateContact(userId, contact, tx))) throw new AppError('NOT_FOUND');
        if (Object.keys(profile).length > 0) await students.update(userId, profile, tx);
      });

      const after = await mustGet(userId);
      await log('UPDATED', actor, ctx, userId, before, after);
      return after;
    },

    /** Puts the student in a class for a session. One class per student per session, so this also moves them. */
    async enrol(userId: string, input: { classArmId: string; sessionId?: string | undefined }, actor: Actor, ctx: Context): Promise<StudentView> {
      const before = await mustGet(userId);
      const arm = await structure.findArm(input.classArmId);
      if (!arm) throw fail('classArmId', 'Class arm not found');
      const session = input.sessionId ? await sessions.findSession(input.sessionId) : await sessions.findCurrentSession();
      if (!session) throw fail('sessionId', input.sessionId ? 'Session not found' : 'There is no current session');

      await enrolments.upsert(userId, session.id, arm.id);

      const after = await mustGet(userId);
      await log('ENROLLED', actor, ctx, userId, before.enrolment, { sessionId: session.id, classArmId: arm.id });
      return after;
    },

    /** Stores the photo in Cloudinary and keeps only its URL. Uploading again replaces the old photo. */
    async setPassport(userId: string, image: Buffer, actor: Actor, ctx: Context): Promise<StudentView> {
      const before = await mustGet(userId);
      const stored = await deps.images.upload(image, passportPublicId(userId));
      await students.update(userId, { passportUrl: stored.url });
      const after = await mustGet(userId);
      await log('PASSPORT_UPDATED', actor, ctx, userId, { passportUrl: before.passportUrl }, { passportUrl: after.passportUrl });
      return after;
    },

    async removePassport(userId: string, actor: Actor, ctx: Context): Promise<StudentView> {
      const before = await mustGet(userId);
      if (before.passportUrl) {
        await deps.images.remove(passportPublicId(userId));
        await students.update(userId, { passportUrl: null });
      }
      const after = await mustGet(userId);
      await log('PASSPORT_REMOVED', actor, ctx, userId, { passportUrl: before.passportUrl }, { passportUrl: null });
      return after;
    },

    async remove(userId: string, actor: Actor, ctx: Context): Promise<void> {
      const before = await mustGet(userId);
      const now = new Date();
      await withTransaction(async (tx) => {
        await users.softDelete(userId, now, tx);
        await students.softDelete(userId, now, tx);
      });
      await tokens.revokeAllSessions(userId);
      await log('DELETED', actor, ctx, userId, before, null);
    },
  };
}

export type StudentService = ReturnType<typeof createStudentService>;