import { z } from 'zod';
import { ROLES, type Role } from '../../config/constants';

export const REQUEST_TYPES = [
  'TEACHER_REVIEW', 'INCIDENT_REPORT', 'RESOURCE_REQUEST', 'LEAVE', 'FEE_WAIVER',
  'REFUND', 'RESULT_PUBLICATION', 'STUDENT_TRANSFER', 'COMPLAINT', 'SUGGESTION',
] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];

const objectId = z.string().regex(/^[a-f0-9]{24}$/);
const title = z.string().trim().min(3).max(150);
const details = z.string().trim().min(1).max(5000);
const reason = z.string().trim().min(3).max(1000);
const kobo = z.number().int().min(1).max(10_000_000_000);

export const LEAVE_TYPES = ['ANNUAL', 'SICK', 'CASUAL', 'MATERNITY', 'PATERNITY', 'OTHER'] as const;

/** Unknown fields are rejected in every payload. */
export const PAYLOAD_SCHEMAS: Record<RequestType, z.ZodType> = {
  TEACHER_REVIEW: z.object({ title, details, period: z.string().trim().min(1).max(60).optional() }).strict(),
  INCIDENT_REPORT: z.object({ title, details, occurredAt: z.iso.datetime() }).strict(),
  RESOURCE_REQUEST: z.object({ title, details, quantity: z.number().int().min(1).max(100_000).optional(), estimatedCostKobo: kobo.optional() }).strict(),
  LEAVE: z.object({ leaveType: z.enum(LEAVE_TYPES), startDate: z.iso.date(), endDate: z.iso.date(), reason }).strict(),
  FEE_WAIVER: z.object({ invoiceId: objectId.optional(), amountKobo: kobo, reason }).strict(),
  REFUND: z.object({ paymentId: objectId.optional(), amountKobo: kobo, reason }).strict(),
  RESULT_PUBLICATION: z.object({ classArmId: objectId, termId: objectId, note: details.optional() }).strict(),
  STUDENT_TRANSFER: z.object({ kind: z.enum(['INTERNAL', 'EXTERNAL']), toClassArmId: objectId.optional(), reason }).strict(),
  COMPLAINT: z.object({ subject: title, details, hideIdentity: z.boolean().default(false) }).strict(),
  SUGGESTION: z.object({ subject: title, details, hideIdentity: z.boolean().default(false) }).strict(),
};

export interface TypeRule {
  creators: readonly Role[];
  /** Whether the request is about one student. */
  student: 'required' | 'optional' | 'none';
  /** Types that are informational can be decided with a plain "noted". */
  canBeNoted: boolean;
}

const { ADMIN: AD, TEACHER: TE, PARENT: PA } = ROLES;

export const TYPE_RULES: Record<RequestType, TypeRule> = {
  TEACHER_REVIEW: { creators: [TE], student: 'none', canBeNoted: true },
  INCIDENT_REPORT: { creators: [TE], student: 'optional', canBeNoted: true },
  RESOURCE_REQUEST: { creators: [TE], student: 'none', canBeNoted: false },
  LEAVE: { creators: [TE, AD], student: 'none', canBeNoted: false },
  FEE_WAIVER: { creators: [AD], student: 'required', canBeNoted: false },
  REFUND: { creators: [AD], student: 'required', canBeNoted: false },
  RESULT_PUBLICATION: { creators: [AD], student: 'none', canBeNoted: false },
  STUDENT_TRANSFER: { creators: [AD], student: 'required', canBeNoted: false },
  COMPLAINT: { creators: [PA], student: 'optional', canBeNoted: true },
  SUGGESTION: { creators: [PA], student: 'none', canBeNoted: true },
};

export function requestTitle(type: RequestType, payload: Record<string, unknown>): string {
  if (typeof payload.title === 'string') return payload.title;
  if (typeof payload.subject === 'string') return payload.subject;
  if (type === 'LEAVE' && typeof payload.leaveType === 'string') return `${payload.leaveType.toLowerCase()} leave`;
  return type.replace(/_/g, ' ').toLowerCase();
}