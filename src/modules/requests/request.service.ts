import type { ZodError } from 'zod';
import { AppError, type ErrorDetail } from '../../common/errors/AppError';
import type { ScopeService } from '../../common/scope/scope.service';
import { isoDateOrNull, schoolDateWindow } from './request.dates';
import { sanitizeDeep, sanitizeText } from '../../common/utils/text';
import { ROLES, type Role } from '../../config/constants';
import { recordSafely, type AuditPort } from '../audit/audit.port';
import type { NotificationService } from '../notifications/notification.service';
import type { parentRepository } from '../users/parent.repository';
import type { staffRepository } from '../users/staff.repository';
import type { studentRepository } from '../users/student.repository';
import type { userRepository } from '../users/user.repository';
import type { RequestEvents } from './request.events';
import { PAYLOAD_SCHEMAS, TYPE_RULES, requestTitle, type RequestType } from './request.payloads';
import type { ListFilter, RequestRecord, requestRepository } from './request.repository';
import {
  REQUEST_STATUS, allowedActions, canView, mayAttempt, statusAfterSubmit,
  type DecisionOutcome, type RequestAction, type RequestStatus, type StepAction,
} from './request.rules';
import type { RequestChecks } from './request.checks';


interface Actor { id: string; role: Role }
interface Context { ip: string; requestId: string }

export interface RequestServiceDeps {
  requests: typeof requestRepository;
  users: Pick<typeof userRepository, 'findIdsByRoles'>;
  names: {
    staff: Pick<typeof staffRepository, 'nameMap'>;
    parents: Pick<typeof parentRepository, 'nameMap'>;
    students: Pick<typeof studentRepository, 'nameMap' | 'findByUserId'>;
  };
  scope: Pick<ScopeService, 'assertCanAccessStudent'>;
  notifier: Pick<NotificationService, 'notify'>;
  events: RequestEvents;
  audit: AuditPort;
  checks?:RequestChecks
}

const fail = (field: string, issue: string): AppError => new AppError('VALIDATION_ERROR', { details: [{ field, issue }] });

function payloadDetails(issues: ZodError['issues']): ErrorDetail[] {
  const details: ErrorDetail[] = [];
  for (const issue of issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) details.push({ field: ['payload', ...issue.path, key].map(String).join('.'), issue: 'Unknown field' });
    } else {
      details.push({ field: ['payload', ...issue.path].map(String).join('.'), issue: issue.message });
    }
  }
  return details.slice(0, 50);
}

const label = (type: RequestType): string => type.replace(/_/g, ' ').toLowerCase();
const snippet = (text: string | null): string => (text ? ` "${text.length > 160 ? `${text.slice(0, 159)}…` : text}"` : '');

export function createRequestService(deps: RequestServiceDeps) {
  const { requests, users, names, scope, notifier, events, audit } = deps;
    const runChecks = async (type: RequestType, payload: Record<string, unknown>, studentId: string | null): Promise<void> => {
    await deps.checks?.run(type, { payload, studentId });
  };

  /** Checks the payload for this type and works out the derived fields. */
  function validatePayload(type: RequestType, raw: Record<string, unknown>) {
    const parsed = PAYLOAD_SCHEMAS[type].safeParse(raw);
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', { details: payloadDetails(parsed.error.issues) });
    const payload = sanitizeDeep(parsed.data) as Record<string, unknown>;
    let workingDays: number | null = null;

    if (type === 'LEAVE') {
      const window = schoolDateWindow(String(payload.startDate), String(payload.endDate));
      if (window.error) throw fail(`payload.${window.error.field}`, window.error.issue);
      workingDays = window.workingDays;
    }
    if (type === 'INCIDENT_REPORT' && isoDateOrNull(payload.occurredAt, true)) {
      throw fail('payload.occurredAt', 'Cannot be in the future');
    }
    return { payload, workingDays, hideIdentity: payload.hideIdentity === true };
  }

  async function checkStudent(actor: Actor, type: RequestType, studentId: string | undefined, hideIdentity: boolean): Promise<string | null> {
    const rule = TYPE_RULES[type].student;
    if (rule === 'none' && studentId) throw fail('studentId', 'Not used for this type of request');
    if (rule === 'required' && !studentId) throw fail('studentId', 'Required for this type of request');
    if (!studentId) return null;
    if (hideIdentity) throw fail('studentId', 'Cannot be combined with hiding your identity');

    await scope.assertCanAccessStudent(actor, studentId); // out of scope is a 404
    if (!(await names.students.findByUserId(studentId))) throw fail('studentId', 'Student not found');
    return studentId;
  }

  async function load(actor: Actor, id: string): Promise<RequestRecord> {
    const record = await requests.findById(id);
    if (!record || !canView(record, actor)) throw new AppError('NOT_FOUND');
    return record;
  }

  function assertAllowed(record: RequestRecord, actor: Actor, action: RequestAction): void {
    if (allowedActions(record, actor).includes(action)) return;
    if (!mayAttempt(action, record, actor)) throw new AppError('FORBIDDEN');
    const message =
      action === 'DECIDE' && record.type === 'LEAVE' && actor.role === ROLES.ADMIN && record.status !== REQUEST_STATUS.ESCALATED
        ? 'This leave is longer than the short-leave limit. Escalate it to the super admin.'
        : undefined;
    throw new AppError('REQUEST_INVALID_TRANSITION', message ? { message } : {});
  }

  async function step(
    record: RequestRecord, actor: Actor, ctx: Context,
    t: { action: StepAction; to: RequestStatus; comment?: string | null; outcome?: DecisionOutcome },
  ): Promise<RequestRecord> {
    const at = new Date();
    const comment = t.comment ?? null;
    const updated = await requests.applyTransition(record.id, {
      from: record.status,
      to: t.to,
      step: { actorId: actor.id, actorRole: actor.role, action: t.action, comment, fromStatus: record.status, toStatus: t.to, at },
      ...(t.outcome ? { decision: { outcome: t.outcome, decidedBy: actor.id, at } } : {}),
    });
    if (!updated) throw new AppError('REQUEST_INVALID_TRANSITION', { message: 'This request was just changed by someone else. Reload it.' });

    await recordSafely(audit, {
      action: `REQUEST_${t.action}`, actorId: actor.id, entityType: 'request', entityId: record.id, ip: ctx.ip, requestId: ctx.requestId,
      before: { status: record.status }, after: { status: t.to },
      metadata: { type: record.type, reference: record.reference, ...(comment ? { comment } : {}), ...(t.outcome ? { outcome: t.outcome } : {}) },
    });
    return updated;
  }

  const cleanComment = (text: string | undefined, required: boolean): string | null => {
    const value = sanitizeText(text ?? '');
    if (required && value.length === 0) throw fail('comment', 'A comment is required');
    return value || null;
  };

  const tell = (userIds: string[], type: string, title: string, body: string, requestId: string, email = true) =>
    notifier.notify({ userIds, type, title, body, data: { requestId }, email });

  /** Joins in names. Anonymous complaints hide the creator from everyone except the creator. */
  async function viewsOf(records: RequestRecord[], viewer: Actor, detailed: boolean) {
    const userIds = records.flatMap((r) => [
      r.createdBy,
      ...(r.decision ? [r.decision.decidedBy] : []),
      ...(detailed ? r.steps.map((s) => s.actorId) : []),
    ]);
    const [staffNames, parentNames, studentNames] = await Promise.all([
      names.staff.nameMap(userIds),
      names.parents.nameMap(userIds),
      names.students.nameMap(records.flatMap((r) => (r.studentId ? [r.studentId] : []))),
    ]);
    const nameOf = (id: string, role: Role): string =>
      staffNames.get(id) ?? parentNames.get(id) ?? (role === ROLES.SUPER_ADMIN ? 'Proprietor' : 'Unknown');

    return records.map((r) => {
      const hidden = r.hideIdentity && viewer.id !== r.createdBy;
      const who = (id: string, role: Role) => (hidden && id === r.createdBy ? null : { id, name: nameOf(id, role), role });
      const base = {
        id: r.id, reference: r.reference, type: r.type, status: r.status, title: requestTitle(r.type, r.payload),
        createdBy: who(r.createdBy, r.createdByRole),
        studentId: r.studentId, studentName: r.studentId ? (studentNames.get(r.studentId) ?? null) : null,
        workingDays: r.workingDays,
        decision: r.decision ? { outcome: r.decision.outcome, decidedBy: who(r.decision.decidedBy, ROLES.ADMIN), at: r.decision.at.toISOString() } : null,
        allowedActions: allowedActions(r, viewer),
        createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
      };
      if (!detailed) return { ...base, payload: null, steps: null };
      return {
        ...base,
        payload: r.payload,
        steps: r.steps.map((s) => ({
          action: s.action, comment: s.comment, fromStatus: s.fromStatus, toStatus: s.toStatus,
          at: s.at.toISOString(), actor: who(s.actorId, s.actorRole),
        })),
      };
    });
  }

  async function detail(record: RequestRecord, viewer: Actor) {
    const [view] = await viewsOf([record], viewer, true);
    if (!view) throw new Error('Request view could not be built');
    return view;
  }

  return {
    async create(actor: Actor, input: { type: RequestType; studentId?: string | undefined; payload: Record<string, unknown> }, ctx: Context) {
      if (!TYPE_RULES[input.type].creators.includes(actor.role)) throw new AppError('FORBIDDEN');
      const checked = validatePayload(input.type, input.payload);
      const studentId = await checkStudent(actor, input.type, input.studentId, checked.hideIdentity);
      await runChecks(input.type, checked.payload, studentId);

      const record = await requests.create({
        type: input.type, payload: checked.payload, studentId, createdBy: actor.id, createdByRole: actor.role,
        hideIdentity: checked.hideIdentity, workingDays: checked.workingDays,
      });
      await recordSafely(audit, {
        action: 'REQUEST_CREATED', actorId: actor.id, entityType: 'request', entityId: record.id, ip: ctx.ip, requestId: ctx.requestId,
        after: { status: record.status }, metadata: { type: record.type, reference: record.reference },
      });
      return detail(record, actor);
    },

    /** Edit a draft, or a request that was returned. */
    async update(actor: Actor, id: string, input: { studentId?: string | undefined; payload: Record<string, unknown> }, ctx: Context) {
      const record = await load(actor, id);
      assertAllowed(record, actor, 'EDIT');
      const checked = validatePayload(record.type, input.payload);
      const studentId = await checkStudent(actor, record.type, input.studentId, checked.hideIdentity);
      await runChecks(record.type, checked.payload, studentId);

      const updated = await requests.editByCreator(
        id, actor.id,
        { payload: checked.payload, studentId, hideIdentity: checked.hideIdentity, workingDays: checked.workingDays },
        { actorId: actor.id, actorRole: actor.role, action: 'EDITED', comment: null, fromStatus: record.status, toStatus: record.status, at: new Date() },
      );
      if (!updated) throw new AppError('REQUEST_INVALID_TRANSITION');

      await recordSafely(audit, {
        action: 'REQUEST_EDITED', actorId: actor.id, entityType: 'request', entityId: id, ip: ctx.ip, requestId: ctx.requestId,
        metadata: { type: record.type, reference: record.reference },
      });
      return detail(updated, actor);
    },

    async submit(actor: Actor, id: string, ctx: Context) {
      const record = await load(actor, id);
      assertAllowed(record, actor, 'SUBMIT');
      validatePayload(record.type, record.payload);
      await runChecks(record.type, record.payload, record.studentId); // nothing leaves the creator unless it is valid

      const to = statusAfterSubmit(record.createdByRole);
      const updated = await step(record, actor, ctx, { action: 'SUBMITTED', to });

      const reviewers = await users.findIdsByRoles([to === REQUEST_STATUS.ESCALATED ? ROLES.SUPER_ADMIN : ROLES.ADMIN]);
      await tell(reviewers, 'REQUEST_SUBMITTED', 'A request needs your attention', `A ${label(record.type)} (${record.reference}) is waiting for you.`, id);
      return detail(updated, actor);
    },

    async comment(actor: Actor, id: string, input: { comment: string }, ctx: Context) {
      const record = await load(actor, id);
      assertAllowed(record, actor, 'COMMENT');
      const text = cleanComment(input.comment, true);

      // An admin's first comment on a new request means it is now being looked at.
      const to = actor.role === ROLES.ADMIN && record.status === REQUEST_STATUS.SUBMITTED ? REQUEST_STATUS.UNDER_REVIEW : record.status;
      const updated = await step(record, actor, ctx, { action: 'COMMENTED', to, comment: text });

      const recipients = actor.id === record.createdBy
        ? await users.findIdsByRoles([record.status === REQUEST_STATUS.ESCALATED ? ROLES.SUPER_ADMIN : ROLES.ADMIN])
        : [record.createdBy];
      await tell(recipients, 'REQUEST_COMMENT', 'New comment on a request', `${record.reference}:${snippet(text)}`, id, false);
      return detail(updated, actor);
    },

    async returnToCreator(actor: Actor, id: string, input: { comment: string }, ctx: Context) {
      const record = await load(actor, id);
      assertAllowed(record, actor, 'RETURN');
      const text = cleanComment(input.comment, true);
      const updated = await step(record, actor, ctx, { action: 'RETURNED', to: REQUEST_STATUS.RETURNED, comment: text });

      await tell([record.createdBy], 'REQUEST_RETURNED', 'Your request was returned', `${record.reference} needs changes:${snippet(text)}`, id);
      return detail(updated, actor);
    },

    async escalate(actor: Actor, id: string, input: { comment?: string | undefined }, ctx: Context) {
      const record = await load(actor, id);
      assertAllowed(record, actor, 'ESCALATE');
      const updated = await step(record, actor, ctx, { action: 'ESCALATED', to: REQUEST_STATUS.ESCALATED, comment: cleanComment(input.comment, false) });

      await tell(await users.findIdsByRoles([ROLES.SUPER_ADMIN]), 'REQUEST_ESCALATED', 'A request needs your decision', `A ${label(record.type)} (${record.reference}) was escalated to you.`, id);
      return detail(updated, actor);
    },

    async close(actor: Actor, id: string, input: { comment: string }, ctx: Context) {
      const record = await load(actor, id);
      assertAllowed(record, actor, 'CLOSE');
      const text = cleanComment(input.comment, true);
      const updated = await step(record, actor, ctx, { action: 'CLOSED', to: REQUEST_STATUS.CLOSED, comment: text });

      await tell([record.createdBy], 'REQUEST_CLOSED', 'Your request was closed', `${record.reference} was closed:${snippet(text)}`, id);
      return detail(updated, actor);
    },

    async decide(actor: Actor, id: string, input: { outcome: DecisionOutcome; comment: string }, ctx: Context) {
      const record = await load(actor, id);
      assertAllowed(record, actor, 'DECIDE');
      if (input.outcome === 'NOTED' && !TYPE_RULES[record.type].canBeNoted) {
        throw fail('outcome', 'This type of request must be approved or rejected');
      }
       if (input.outcome === 'APPROVED') await runChecks(record.type, record.payload, record.studentId);
      const text = cleanComment(input.comment, true);
      const updated = await step(record, actor, ctx, { action: 'DECIDED', to: REQUEST_STATUS.DECIDED, comment: text, outcome: input.outcome });

      await tell([record.createdBy], 'REQUEST_DECIDED', 'A decision was made on your request', `${record.reference} was ${input.outcome.toLowerCase()}:${snippet(text)}`, id);
      await events.emitDecided({
        requestId: record.id, reference: record.reference, type: record.type, outcome: input.outcome, studentId: record.studentId,
        payload: record.payload, createdBy: record.createdBy, decidedBy: actor.id, at: new Date(),
      });
      return detail(updated, actor);
    },

    async list(
      actor: Actor,
      input: { page: number; limit: number; sort: '-createdAt' | '-updatedAt'; status?: RequestStatus | undefined; type?: RequestType | undefined; mine?: boolean | undefined; needsAction?: boolean | undefined; studentId?: string | undefined },
    ) {
      const reviewer = actor.role === ROLES.ADMIN || actor.role === ROLES.SUPER_ADMIN;
      const filter: ListFilter = { type: input.type, studentId: input.studentId };

      if (!reviewer || input.mine) filter.createdBy = actor.id;
      else filter.reviewerId = actor.id;

      let statuses: RequestStatus[] | undefined;
      if (input.needsAction) {
        if (actor.role === ROLES.ADMIN) { statuses = [REQUEST_STATUS.SUBMITTED, REQUEST_STATUS.UNDER_REVIEW]; filter.excludeCreatedBy = actor.id; delete filter.createdBy; }
        else if (actor.role === ROLES.SUPER_ADMIN) { statuses = [REQUEST_STATUS.ESCALATED]; filter.excludeCreatedBy = actor.id; delete filter.createdBy; }
        else statuses = [REQUEST_STATUS.RETURNED];
      }
      if (input.status) statuses = statuses ? statuses.filter((s) => s === input.status) : [input.status];
      if (statuses) filter.statuses = statuses;

      const { items, total } = await requests.list(filter, { page: input.page, limit: input.limit, sort: input.sort });
      return { items: await viewsOf(items, actor, false), total };
    },

    async get(actor: Actor, id: string) {
      return detail(await load(actor, id), actor);
    },
  };
}

export type RequestService = ReturnType<typeof createRequestService>;