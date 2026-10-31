import { createHmac, randomInt } from 'node:crypto';
import { AppError } from '../../common/errors/AppError';
import { recordSafely, type AuditPort } from '../audit/audit.port';
import type { KeyValueStore } from '../auth/keyValueStore';
import { LINK_STATUS, type LinkRecord, type LinkStatus, type Relationship, type linkRepository } from './link.repository';
import type { parentRepository } from './parent.repository';
import type { studentRepository } from './student.repository';
import type { StudentService } from './student.service';

interface Actor { id: string }
interface Context { ip: string; requestId: string }

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0 or 1
const CODE_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/;
const CODE_TTL_SECONDS = 14 * 24 * 60 * 60;

export interface LinkServiceDeps {
  links: typeof linkRepository;
  parents: Pick<typeof parentRepository, 'findByUserId' | 'nameMap'>;
  students: Pick<typeof studentRepository, 'findByUserId' | 'nameMap'>;
  studentViews: Pick<StudentService, 'viewsByUserIds'>;
  store: KeyValueStore;
  secret: string;
  audit: AuditPort;
}

const fail = (field: string, issue: string): AppError =>
  new AppError('VALIDATION_ERROR', { details: [{ field, issue }] });

export function createLinkService(deps: LinkServiceDeps) {
  const { links, parents, students, store, audit } = deps;

  const fp = (canonical: string): string => createHmac('sha256', deps.secret).update(`claim:${canonical}`).digest('hex');
  const codeKey = (hash: string) => `link:code:${hash}`;
  const studentKey = (studentId: string) => `link:code-of:${studentId}`;

  const log = (event: string, actor: Actor, ctx: Context, id: string, metadata: Record<string, unknown>) =>
    recordSafely(audit, { action: event, actorId: actor.id, entityType: 'link', entityId: id, ip: ctx.ip, requestId: ctx.requestId, metadata });

  async function viewsOf(records: LinkRecord[]) {
    const [parentNames, studentNames] = await Promise.all([
      parents.nameMap(records.map((l) => l.parentId)),
      students.nameMap(records.map((l) => l.studentId)),
    ]);
    return records.map((l) => ({
      id: l.id,
      parentId: l.parentId,
      parentName: parentNames.get(l.parentId) ?? '',
      studentId: l.studentId,
      studentName: studentNames.get(l.studentId) ?? '',
      relationship: l.relationship,
      status: l.status,
      createdAt: l.createdAt.toISOString(),
    }));
  }
  const viewOf = async (record: LinkRecord) => {
    const [view] = await viewsOf([record]);
    if (!view) throw new Error('Link view could not be built');
    return view;
  };

  return {
    /** An admin links a parent to a student directly. It is active at once. */
    async link(parentId: string, input: { studentId: string; relationship: Relationship }, actor: Actor, ctx: Context) {
      if (!(await parents.findByUserId(parentId))) throw new AppError('NOT_FOUND');
      if (!(await students.findByUserId(input.studentId))) throw fail('studentId', 'Student not found');

      const existing = await links.find(parentId, input.studentId);
      if (existing?.status === LINK_STATUS.ACTIVE) throw new AppError('CONFLICT', { message: 'This parent is already linked to this student' });

      const saved = await links.upsert({ parentId, studentId: input.studentId, relationship: input.relationship, status: LINK_STATUS.ACTIVE });
      await log('PARENT_LINK_CREATED', actor, ctx, saved.id, { parentId, studentId: input.studentId });
      return viewOf(saved);
    },

    async list(input: { page: number; limit: number; status?: LinkStatus | undefined; parentId?: string | undefined; studentId?: string | undefined }) {
      const { page, limit, ...filter } = input;
      const { items, total } = await links.list(filter, { page, limit });
      return { items: await viewsOf(items), total };
    },

    /** Approve a pending claim, or revoke a link. Revoked links can be restored by an admin. */
    async setStatus(id: string, status: 'ACTIVE' | 'REVOKED', actor: Actor, ctx: Context) {
      const existing = await links.findById(id);
      if (!existing) throw new AppError('NOT_FOUND');
      if (existing.status === status) return viewOf(existing);

      const updated = await links.setStatus(id, status);
      if (!updated) throw new AppError('NOT_FOUND');
      await log(status === 'ACTIVE' ? 'PARENT_LINK_APPROVED' : 'PARENT_LINK_REVOKED', actor, ctx, id, { from: existing.status, to: status });
      return viewOf(updated);
    },

    /** A one-time code the school gives a parent. It is shown once and cannot be retrieved again. */
    async createClaimCode(studentId: string, actor: Actor, ctx: Context) {
      if (!(await students.findByUserId(studentId))) throw new AppError('NOT_FOUND');

      const canonical = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)] ?? 'A').join('');
      const hash = fp(canonical);
      const previous = await store.get(studentKey(studentId));

      await store.setMany([
        { key: codeKey(hash), value: JSON.stringify({ studentId }), ttlSeconds: CODE_TTL_SECONDS },
        { key: studentKey(studentId), value: hash, ttlSeconds: CODE_TTL_SECONDS },
      ]);
      if (previous && previous !== hash) await store.delete(codeKey(previous)); // a new code replaces the old one

      await log('PARENT_CLAIM_CODE_CREATED', actor, ctx, studentId, {});
      return {
        code: `${canonical.slice(0, 4)}-${canonical.slice(4)}`,
        expiresAt: new Date(Date.now() + CODE_TTL_SECONDS * 1000).toISOString(),
      };
    },

    /** A parent claims a child with a code. The link stays pending until an admin approves it. */
    async claim(parentId: string, input: { code: string; relationship: Relationship }, ctx: Context) {
      const invalid = fail('code', 'This code is invalid or has expired');
      const canonical = input.code.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!CODE_PATTERN.test(canonical)) throw invalid;
      if (!(await parents.findByUserId(parentId))) throw new AppError('NOT_FOUND');

      const key = codeKey(fp(canonical));
      let studentId: string | null = null;
      try {
        const raw = await store.get(key);
        const parsed: unknown = raw ? JSON.parse(raw) : null;
        studentId = parsed && typeof parsed === 'object' && 'studentId' in parsed && typeof parsed.studentId === 'string' ? parsed.studentId : null;
      } catch {
        studentId = null;
      }
      if (!studentId) throw invalid;

      const existing = await links.find(parentId, studentId);
      if (existing?.status === LINK_STATUS.ACTIVE) throw new AppError('CONFLICT', { message: 'You are already linked to this student' });
      if (existing?.status === LINK_STATUS.PENDING) throw new AppError('CONFLICT', { message: 'Your request is already waiting for approval' });
      if (existing) throw new AppError('CONFLICT', { message: 'Please contact the school to restore this link' });

      // The code works once: of two simultaneous uses, only one gets it.
      if ((await store.getAndDelete(key)) === null) throw invalid;
      await store.delete(studentKey(studentId));

      const created = await links.createPending({ parentId, studentId, relationship: input.relationship });
      if (!created) throw new AppError('CONFLICT', { message: 'Your request is already waiting for approval' });

      await log('PARENT_LINK_CLAIMED', { id: parentId }, ctx, created.id, { studentId });
      return viewOf(created);
    },

    /** The parent's own children: active links only. */
    async myChildren(parentId: string) {
      return deps.studentViews.viewsByUserIds(await links.activeStudentIdsOf(parentId));
    },
  };
}

export type LinkService = ReturnType<typeof createLinkService>;