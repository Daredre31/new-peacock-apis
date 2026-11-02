import { LEAVE_POLICY, ROLES, type Role } from '../../config/constants';
import type { RequestType } from './request.payloads';

export const REQUEST_STATUS = {
  DRAFT: 'DRAFT', SUBMITTED: 'SUBMITTED', UNDER_REVIEW: 'UNDER_REVIEW', RETURNED: 'RETURNED',
  ESCALATED: 'ESCALATED', DECIDED: 'DECIDED', CLOSED: 'CLOSED',
} as const;
export type RequestStatus = (typeof REQUEST_STATUS)[keyof typeof REQUEST_STATUS];

export const STEP_ACTIONS = ['CREATED', 'EDITED', 'SUBMITTED', 'COMMENTED', 'RETURNED', 'ESCALATED', 'CLOSED', 'DECIDED'] as const;
export type StepAction = (typeof STEP_ACTIONS)[number];

export const DECISION_OUTCOMES = ['APPROVED', 'REJECTED', 'NOTED'] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

export type RequestAction = 'EDIT' | 'SUBMIT' | 'COMMENT' | 'RETURN' | 'ESCALATE' | 'CLOSE' | 'DECIDE';

export interface RequestFacts {
  type: RequestType;
  status: RequestStatus;
  createdBy: string;
  createdByRole: Role;
  workingDays: number | null;
}
export interface RuleActor { id: string; role: Role }

const { DRAFT, SUBMITTED, UNDER_REVIEW, RETURNED, ESCALATED, DECIDED, CLOSED } = REQUEST_STATUS;
const REVIEWING: readonly RequestStatus[] = [SUBMITTED, UNDER_REVIEW];

export const isReviewing = (status: RequestStatus): boolean => REVIEWING.includes(status);
export const isLongLeave = (f: RequestFacts): boolean => f.type === 'LEAVE' && (f.workingDays ?? 0) > LEAVE_POLICY.longLeaveAfterWorkingDays;

/** Creators see their own requests. Admins and the super admin see everything that has left draft. */
export function canView(f: RequestFacts, actor: RuleActor): boolean {
  if (actor.id === f.createdBy) return true;
  return (actor.role === ROLES.ADMIN || actor.role === ROLES.SUPER_ADMIN) && f.status !== DRAFT;
}

/** What this person can do with this request right now. The API enforces it and the frontend uses it to show buttons. */
export function allowedActions(f: RequestFacts, actor: RuleActor): RequestAction[] {
  const creator = actor.id === f.createdBy;
  const admin = actor.role === ROLES.ADMIN;
  const owner = actor.role === ROLES.SUPER_ADMIN;
  const s = f.status;
  const out: RequestAction[] = [];

  if (creator && (s === DRAFT || s === RETURNED)) out.push('EDIT', 'SUBMIT');
  if (s !== DRAFT && s !== DECIDED && s !== CLOSED && (creator || admin || owner)) out.push('COMMENT');

  if (admin && !creator) {
    if (isReviewing(s)) {
      out.push('RETURN', 'ESCALATE', 'CLOSE');
      // Short leave is decided by the admin without escalation. Long leave goes to the super admin.
      if (f.type === 'LEAVE' && f.createdByRole === ROLES.TEACHER && !isLongLeave(f)) out.push('DECIDE');
    } else if (s === RETURNED) {
      out.push('CLOSE');
    }
  }

  if (owner && !creator) {
    if (isReviewing(s) || s === ESCALATED) out.push('RETURN');
    if (isReviewing(s) || s === ESCALATED || s === RETURNED) out.push('CLOSE');
    if (s === ESCALATED) out.push('DECIDE');
  }
  return out;
}

/** Whether this role could ever do this action. Separates "not yours" (403) from "not now" (409). */
export function mayAttempt(action: RequestAction, f: RequestFacts, actor: RuleActor): boolean {
  const creator = actor.id === f.createdBy;
  const admin = actor.role === ROLES.ADMIN;
  const owner = actor.role === ROLES.SUPER_ADMIN;
  switch (action) {
    case 'EDIT':
    case 'SUBMIT':
      return creator;
    case 'COMMENT':
      return creator || admin || owner;
    case 'ESCALATE':
      return admin && !creator;
    default:
      return (admin || owner) && !creator;
  }
}

/** Requests created by an admin skip admin review and go straight to the super admin. */
export const statusAfterSubmit = (creatorRole: Role): RequestStatus => (creatorRole === ROLES.ADMIN ? ESCALATED : SUBMITTED);