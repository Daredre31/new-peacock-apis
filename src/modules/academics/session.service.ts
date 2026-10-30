import { AppError } from '../../common/errors/AppError';
import { recordSafely, type AuditPort } from '../audit/audit.port';
import {
  sessionRepository as repo,
  type SessionRecord,
  type SessionSort,
  type TermRecord,
  type TermSort,
} from './session.repository';

interface Actor {
  id: string;
}
interface Context {
  ip: string;
  requestId: string;
}
interface Page<S> {
  page: number;
  limit: number;
  sort: S;
}
interface DateFields {
  name: string;
  startDate: Date;
  endDate: Date;
}

const fail = (field: string, issue: string): AppError =>
  new AppError('VALIDATION_ERROR', { details: [{ field, issue }] });

const sessionView = (s: SessionRecord) => ({
  id: s.id,
  name: s.name,
  startDate: s.startDate.toISOString(),
  endDate: s.endDate.toISOString(),
  isCurrent: s.isCurrent,
});

const termView = (t: TermRecord) => ({
  ...sessionView(t),
  sessionId: t.sessionId,
  locked: t.locked,
});

export type SessionView = ReturnType<typeof sessionView>;
export type TermView = ReturnType<typeof termView>;

function assertSessionName(name: string): void {
  const [first, second] = name.split('/').map(Number);
  if (first === undefined || second === undefined || second !== first + 1) {
    throw fail('name', 'Years must be consecutive, like 2026/2027');
  }
}

function assertRange(start: Date, end: Date): void {
  if (end <= start) throw fail('endDate', 'Must be after the start date');
}

function assertNotEmpty(patch: object): void {
  if (Object.keys(patch).length === 0) throw fail('body', 'Nothing to update');
}

export function createSessionService(deps: { audit: AuditPort }) {
  const { audit } = deps;

  async function mustFindTerm(id: string): Promise<TermRecord> {
    const term = await repo.findTerm(id);
    if (!term) throw new AppError('NOT_FOUND');
    return term;
  }

  const log = (
    action: string,
    entityType: 'session' | 'term',
    actor: Actor,
    ctx: Context,
    entityId: string,
    before: object | null,
    after: object | null,
  ) =>
    recordSafely(audit, {
      action,
      actorId: actor.id,
      entityType,
      entityId,
      ip: ctx.ip,
      requestId: ctx.requestId,
      before: before as Record<string, unknown> | null,
      after: after as Record<string, unknown> | null,
    });

  return {
    async listSessions(input: Page<SessionSort> & { q?: string; isCurrent?: boolean }) {
      const { page, limit, sort, ...filter } = input;
      const { items, total } = await repo.listSessions(filter, { page, limit, sort });
      return { items: items.map(sessionView), total };
    },

    async createSession(input: DateFields, actor: Actor, ctx: Context): Promise<SessionView> {
      assertSessionName(input.name);
      assertRange(input.startDate, input.endDate);
      if (await repo.sessionOverlaps(input.startDate, input.endDate)) {
        throw new AppError('CONFLICT', { message: 'These dates overlap another session' });
      }

      const created = sessionView(await repo.createSession(input));
      await log('SESSION_CREATED', 'session', actor, ctx, created.id, null, created);
      return created;
    },

    async updateSession(id: string, patch: Partial<DateFields>, actor: Actor, ctx: Context): Promise<SessionView> {
      assertNotEmpty(patch);
      const existing = await repo.findSession(id);
      if (!existing) throw new AppError('NOT_FOUND');

      const merged = { ...existing, ...patch };
      assertSessionName(merged.name);
      assertRange(merged.startDate, merged.endDate);
      if (await repo.sessionOverlaps(merged.startDate, merged.endDate, id)) {
        throw new AppError('CONFLICT', { message: 'These dates overlap another session' });
      }

      const terms = await repo.findTermsOfSession(id);
      if (terms.some((t) => t.startDate < merged.startDate || t.endDate > merged.endDate)) {
        throw new AppError('CONFLICT', { message: 'A term of this session falls outside the new dates' });
      }

      const updated = await repo.updateSession(id, patch);
      if (!updated) throw new AppError('NOT_FOUND');

      const after = sessionView(updated);
      await log('SESSION_UPDATED', 'session', actor, ctx, id, sessionView(existing), after);
      return after;
    },

    async listTerms(input: Page<TermSort> & { sessionId?: string; isCurrent?: boolean; locked?: boolean }) {
      const { page, limit, sort, ...filter } = input;
      const { items, total } = await repo.listTerms(filter, { page, limit, sort });
      return { items: items.map(termView), total };
    },

    async createTerm(input: DateFields & { sessionId: string }, actor: Actor, ctx: Context): Promise<TermView> {
      const session = await repo.findSession(input.sessionId);
      if (!session) throw fail('sessionId', 'Session not found');

      assertRange(input.startDate, input.endDate);
      if (input.startDate < session.startDate || input.endDate > session.endDate) {
        throw fail('startDate', 'The term must fall inside its session dates');
      }
      if (await repo.termOverlaps(input.sessionId, input.startDate, input.endDate)) {
        throw new AppError('CONFLICT', { message: 'These dates overlap another term of this session' });
      }

      const created = termView(await repo.createTerm(input));
      await log('TERM_CREATED', 'term', actor, ctx, created.id, null, created);
      return created;
    },

    async updateTerm(id: string, patch: Partial<DateFields>, actor: Actor, ctx: Context): Promise<TermView> {
      assertNotEmpty(patch);
      const existing = await mustFindTerm(id);
      if (existing.locked) throw new AppError('CONFLICT', { message: 'This term is closed' });

      const session = await repo.findSession(existing.sessionId);
      if (!session) throw new AppError('NOT_FOUND');

      const merged = { ...existing, ...patch };
      assertRange(merged.startDate, merged.endDate);
      if (merged.startDate < session.startDate || merged.endDate > session.endDate) {
        throw fail('startDate', 'The term must fall inside its session dates');
      }
      if (await repo.termOverlaps(existing.sessionId, merged.startDate, merged.endDate, id)) {
        throw new AppError('CONFLICT', { message: 'These dates overlap another term of this session' });
      }

      const updated = await repo.updateTerm(id, patch);
      if (!updated) throw new AppError('NOT_FOUND');

      const after = termView(updated);
      await log('TERM_UPDATED', 'term', actor, ctx, id, termView(existing), after);
      return after;
    },

    /** Makes this term (and its session) the current one. Idempotent. */
    async setCurrentTerm(id: string, actor: Actor, ctx: Context): Promise<TermView> {
      const term = await mustFindTerm(id);
      if (term.locked) {
        throw new AppError('CONFLICT', { message: 'Reopen this term before making it current' });
      }
      if (term.isCurrent) return termView(term);

      await repo.makeTermCurrent(term.id, term.sessionId);

      const after = termView(await mustFindTerm(id));
      await log('TERM_SET_CURRENT', 'term', actor, ctx, id, termView(term), after);
      return after;
    },

    async closeTerm(id: string, actor: Actor, ctx: Context): Promise<TermView> {
      const term = await mustFindTerm(id);
      if (term.locked) return termView(term);

      const updated = await repo.setTermLocked(id, true);
      if (!updated) throw new AppError('NOT_FOUND');

      const after = termView(updated);
      await log('TERM_CLOSED', 'term', actor, ctx, id, termView(term), after);
      return after;
    },

    async reopenTerm(id: string, actor: Actor, ctx: Context): Promise<TermView> {
      const term = await mustFindTerm(id);
      if (!term.locked) return termView(term);

      const updated = await repo.setTermLocked(id, false);
      if (!updated) throw new AppError('NOT_FOUND');

      const after = termView(updated);
      await log('TERM_REOPENED', 'term', actor, ctx, id, termView(term), after);
      return after;
    },
  };
}

export type SessionService = ReturnType<typeof createSessionService>;