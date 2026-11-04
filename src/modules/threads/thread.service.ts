import { AppError } from '../../common/errors/AppError';
import type { ScopeService } from '../../common/scope/scope.service';
import { sanitizeText } from '../../common/utils/text';
import { ROLES, type Role } from '../../config/constants';
import { withTransaction } from '../../config/db';
import type { assignmentRepository } from '../academics/assignment.repository';
import type { enrolmentRepository } from '../academics/enrolment.repository';
import type { sessionRepository } from '../academics/session.repository';
import type { structureRepository } from '../academics/structure.repository';
import { recordSafely, type AuditPort } from '../audit/audit.port';
import { decodeCursor } from '../notifications/notification.repository';
import type { NotificationService } from '../notifications/notification.service';
import type { linkRepository } from '../users/link.repository';
import type { parentRepository } from '../users/parent.repository';
import type { staffRepository } from '../users/staff.repository';
import type { studentRepository } from '../users/student.repository';
import type { userRepository } from '../users/user.repository';
import {
  THREAD_STATUS, type ThreadAudience, type ThreadCategory, type ThreadRecord, type ThreadStatus, type threadRepository,
} from './thread.repository';

interface Actor { id: string; role: Role }
interface Context { ip: string; requestId: string }

const MAX_OPEN_THREADS = 20;
const fail = (field: string, issue: string): AppError => new AppError('VALIDATION_ERROR', { details: [{ field, issue }] });

export function createThreadService(deps: {
  threads: typeof threadRepository;
  scope: Pick<ScopeService, 'assertCanAccessStudent'>;
  links: Pick<typeof linkRepository, 'activeStudentIdsOf'>;
  enrolments: Pick<typeof enrolmentRepository, 'forStudents'>;
  sessions: Pick<typeof sessionRepository, 'findCurrentSession'>;
  structure: Pick<typeof structureRepository, 'findArm' | 'subjectsByIds'>;
  assignments: Pick<typeof assignmentRepository, 'list'>;
  staff: Pick<typeof staffRepository, 'nameMap'>;
  parents: Pick<typeof parentRepository, 'nameMap'>;
  students: Pick<typeof studentRepository, 'nameMap'>;
  users: Pick<typeof userRepository, 'findIdsByRoles'>;
  notifier: Pick<NotificationService, 'notify'>;
  audit: AuditPort;
}) {
  const { threads, scope, links, enrolments, sessions, structure, assignments, staff, parents, students, users, notifier, audit } = deps;

  async function viewsOf(records: ThreadRecord[]) {
    const [studentNames, parentNames, teacherNames] = await Promise.all([
      students.nameMap(records.map((t) => t.studentId)), parents.nameMap(records.map((t) => t.parentId)),
      staff.nameMap(records.flatMap((t) => (t.teacherId ? [t.teacherId] : []))),
    ]);
    return records.map((t) => ({
      id: t.id, category: t.category, subject: t.subject, status: t.status, audience: t.audience,
      student: { id: t.studentId, name: studentNames.get(t.studentId) ?? '' },
      parent: { id: t.parentId, name: parentNames.get(t.parentId) ?? '' },
      teacher: t.teacherId ? { id: t.teacherId, name: teacherNames.get(t.teacherId) ?? '' } : null,
      lastMessageAt: t.lastMessageAt.toISOString(), lastSenderRole: t.lastSenderRole, messageCount: t.messageCount,
      createdAt: t.createdAt.toISOString(),
    }));
  }
  const viewOf = async (t: ThreadRecord) => {
    const [v] = await viewsOf([t]);
    if (!v) throw new Error('Thread view could not be built');
    return v;
  };

  /** A parent sees their own threads about linked children. A teacher sees threads addressed to them. An admin sees all. */
  async function load(actor: Actor, id: string): Promise<ThreadRecord> {
    const thread = await threads.findById(id);
    if (!thread) throw new AppError('NOT_FOUND');
    if (actor.role === ROLES.ADMIN) return thread;
    if (actor.role === ROLES.PARENT && thread.parentId === actor.id) { await scope.assertCanAccessStudent(actor, thread.studentId); return thread; }
    if (actor.role === ROLES.TEACHER && thread.teacherId === actor.id) { await scope.assertCanAccessStudent(actor, thread.studentId); return thread; }
    throw new AppError('NOT_FOUND');
  }

  /** The people a parent can write to for one child: the class teacher and the subject teachers. */
  async function teachersOfChild(actor: Actor, studentId: string) {
    await scope.assertCanAccessStudent(actor, studentId);
    const current = await sessions.findCurrentSession();
    const armId = current ? (await enrolments.forStudents([studentId], current.id)).get(studentId)?.classArmId : undefined;
    if (!current || !armId) return [];

    const [arm, { items }] = await Promise.all([structure.findArm(armId), assignments.list({ classArmId: armId, sessionId: current.id }, { page: 1, limit: 100, sort: '-createdAt' })]);
    const subjects = await structure.subjectsByIds(items.map((a) => a.subjectId));
    const teacherIds = [...new Set([...(arm?.classTeacherId ? [arm.classTeacherId] : []), ...items.map((a) => a.teacherId)])];
    const names = await staff.nameMap(teacherIds);

    return teacherIds.map((id) => ({
      teacherId: id, name: names.get(id) ?? '', classTeacher: id === arm?.classTeacherId,
      subjects: items.filter((a) => a.teacherId === id).flatMap((a) => { const s = subjects.get(a.subjectId); return s ? [s.name] : []; }),
    }));
  }

  const notifyOther = async (thread: ThreadRecord, from: Actor, title: string): Promise<void> => {
    const to = from.role === ROLES.PARENT
      ? thread.audience === 'ADMIN' ? await users.findIdsByRoles([ROLES.ADMIN]) : thread.teacherId ? [thread.teacherId] : []
      : [thread.parentId];
    await notifier.notify({ userIds: to, type: 'THREAD_MESSAGE', title, body: `Conversation: ${thread.subject}`, data: { threadId: thread.id }, email: false });
  };

  return {
    teachersOfChild,

    async create(actor: Actor, input: { studentId: string; category: ThreadCategory; subject: string; body: string; to: ThreadAudience; teacherId?: string | undefined }, ctx: Context) {
      await scope.assertCanAccessStudent(actor, input.studentId); // linked children only
      if ((await threads.countOpenForParent(actor.id)) >= MAX_OPEN_THREADS) {
        throw new AppError('CONFLICT', { message: `You already have ${MAX_OPEN_THREADS} open conversations. Wait for a reply or close some.` });
      }

      let teacherId: string | null = null;
      if (input.to === 'TEACHER') {
        const options = await teachersOfChild(actor, input.studentId);
        if (options.length === 0) throw fail('to', 'This class has no teacher assigned yet. Send it to the school office instead');
        const chosen = input.teacherId ?? options.find((o) => o.classTeacher)?.teacherId ?? options[0]?.teacherId;
        if (!chosen || !options.some((o) => o.teacherId === chosen)) throw fail('teacherId', "Not one of this child's teachers");
        teacherId = chosen;
      } else if (input.teacherId) {
        throw fail('teacherId', 'Not used when writing to the school office');
      }

      const subject = sanitizeText(input.subject);
      const body = sanitizeText(input.body);
      if (!subject) throw fail('subject', 'Required');
      if (!body) throw fail('body', 'Write your message');

      const created = await withTransaction((session) =>
        threads.create({ parentId: actor.id, studentId: input.studentId, teacherId, audience: input.to, category: input.category, subject }, body, actor, session),
      );

      await notifyOther(created, actor, 'New message from a parent');
      // The audit log records that a conversation happened, never what was said.
      await recordSafely(audit, {
        action: 'THREAD_CREATED', actorId: actor.id, entityType: 'thread', entityId: created.id, ip: ctx.ip, requestId: ctx.requestId,
        metadata: { category: input.category, audience: input.to },
      });
      return viewOf(created);
    },

    async list(actor: Actor, input: { page: number; limit: number; status?: ThreadStatus | undefined; category?: ThreadCategory | undefined; studentId?: string | undefined }) {
      const filter = { status: input.status, category: input.category, studentId: input.studentId };
      let scoped: { parentId?: string; teacherId?: string; studentIds?: string[] } = {};
      if (actor.role === ROLES.PARENT) scoped = { parentId: actor.id, studentIds: await links.activeStudentIdsOf(actor.id) };
      else if (actor.role === ROLES.TEACHER) scoped = { teacherId: actor.id };
      else if (actor.role !== ROLES.ADMIN) throw new AppError('FORBIDDEN');

      const { items, total } = await threads.list({ ...filter, ...scoped }, { page: input.page, limit: input.limit });
      return { items: await viewsOf(items), total };
    },

    /** The thread and a page of its messages, oldest to newest. Send nextCursor back to load earlier ones. */
    async get(actor: Actor, id: string, input: { limit: number; cursor?: string | undefined }) {
      const thread = await load(actor, id);
      let before: string | null = null;
      if (input.cursor) {
        before = decodeCursor(input.cursor);
        if (!before) throw fail('cursor', 'Invalid cursor');
      }
      const [view, page] = await Promise.all([viewOf(thread), threads.messages(id, { limit: input.limit, before })]);

      const [parentNames, staffNames] = await Promise.all([parents.nameMap(page.items.map((m) => m.senderId)), staff.nameMap(page.items.map((m) => m.senderId))]);
      return {
        thread: view, nextCursor: page.nextCursor,
        messages: page.items.map((m) => ({
          id: m.id, senderId: m.senderId, senderRole: m.senderRole,
          senderName: parentNames.get(m.senderId) ?? staffNames.get(m.senderId) ?? '', body: m.body, createdAt: m.createdAt.toISOString(),
        })),
      };
    },

    async reply(actor: Actor, id: string, input: { body: string }, ctx: Context) {
      const thread = await load(actor, id);
      // An admin may reply to threads addressed to the office. Threads addressed to a teacher are read-only for admins.
      const participant = actor.role === ROLES.PARENT || (actor.role === ROLES.TEACHER && thread.teacherId === actor.id) || (actor.role === ROLES.ADMIN && thread.audience === 'ADMIN');
      if (!participant) throw new AppError('FORBIDDEN');

      const body = sanitizeText(input.body);
      if (!body) throw fail('body', 'Write your message');
      const next: ThreadStatus = actor.role === ROLES.PARENT ? THREAD_STATUS.OPEN : THREAD_STATUS.ANSWERED;

      const added = await withTransaction((session) => threads.addMessage(id, actor, body, next, session));
      if (!added) throw new AppError('CONFLICT', { message: thread.status === THREAD_STATUS.CLOSED ? 'This conversation is closed' : 'This conversation has reached its message limit. Please start a new one.' });

      await notifyOther(thread, actor, actor.role === ROLES.PARENT ? 'New message from a parent' : 'You have a reply');
      await recordSafely(audit, { action: 'THREAD_REPLIED', actorId: actor.id, entityType: 'thread', entityId: id, ip: ctx.ip, requestId: ctx.requestId });
      return { id, status: next };
    },

    /** The teacher or an admin marks a conversation answered or closed. Only a parent's reply reopens an answered one. */
    async setStatus(actor: Actor, id: string, status: 'ANSWERED' | 'CLOSED', ctx: Context) {
      const thread = await load(actor, id);
      const from: ThreadStatus[] = status === 'ANSWERED' ? [THREAD_STATUS.OPEN] : [THREAD_STATUS.OPEN, THREAD_STATUS.ANSWERED];
      const updated = await threads.transition(id, from, status);
      if (!updated) {
        if (thread.status === status) return viewOf(thread);
        throw new AppError('CONFLICT', { message: thread.status === THREAD_STATUS.CLOSED ? 'This conversation is closed' : 'This conversation cannot move to that status' });
      }

      if (status === 'CLOSED') await notifier.notify({ userIds: [thread.parentId], type: 'THREAD_CLOSED', title: 'A conversation was closed', body: `Conversation: ${thread.subject}`, data: { threadId: id }, email: false });
      await recordSafely(audit, { action: `THREAD_${status}`, actorId: actor.id, entityType: 'thread', entityId: id, ip: ctx.ip, requestId: ctx.requestId });
      return viewOf(updated);
    },
  };
}

export type ThreadService = ReturnType<typeof createThreadService>;