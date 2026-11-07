import mongoose, { type Model, type Types } from 'mongoose';
import { skipOf } from '../../common/utils/pagination';
import { ALL_ROLES, type Role } from '../../config/constants';
import { nextSequence } from '../users/counter.model';
import { REQUEST_TYPES, type RequestType } from './request.payloads';
// import type { RequestCheck } from './request.checks';
import {
  DECISION_OUTCOMES, REQUEST_STATUS, STEP_ACTIONS,
  type DecisionOutcome, type RequestStatus, type StepAction,
} from './request.rules';

interface StepDoc {
  actorId: Types.ObjectId; actorRole: Role; action: StepAction; comment: string | null;
  fromStatus: RequestStatus | null; toStatus: RequestStatus; at: Date;
}
interface RequestDocument {
  reference: string;
  type: RequestType;
  status: RequestStatus;
  payload: Record<string, unknown>;
  studentId: Types.ObjectId | null;
  createdBy: Types.ObjectId;
  createdByRole: Role;
  hideIdentity: boolean;
  workingDays: number | null;
  steps: StepDoc[];
  decision: { outcome: DecisionOutcome; decidedBy: Types.ObjectId; at: Date } | null;
  createdAt: Date;
  updatedAt: Date;
  
}
type Row = RequestDocument & { _id: Types.ObjectId };

const stepSchema = new mongoose.Schema(
  {
    actorId: { type: mongoose.Schema.Types.ObjectId, required: true },
    actorRole: { type: String, enum: ALL_ROLES, required: true },
    action: { type: String, enum: STEP_ACTIONS, required: true },
    comment: { type: String, default: null, maxlength: 2000 },
    fromStatus: { type: String, default: null },
    toStatus: { type: String, required: true },
    at: { type: Date, required: true },
  },
  { _id: false },
);
const decisionSchema = new mongoose.Schema(
  {
    outcome: { type: String, enum: DECISION_OUTCOMES, required: true },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, required: true },
    at: { type: Date, required: true },
  },
  { _id: false },
);

const schema = new mongoose.Schema<RequestDocument>(
  {
    reference: { type: String, required: true },
    type: { type: String, enum: REQUEST_TYPES, required: true },
    status: { type: String, enum: Object.values(REQUEST_STATUS), default: REQUEST_STATUS.DRAFT },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    studentId: { type: mongoose.Schema.Types.ObjectId, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    createdByRole: { type: String, enum: ALL_ROLES, required: true },
    hideIdentity: { type: Boolean, default: false },
    workingDays: { type: Number, default: null },
    steps: { type: [stepSchema], default: [] },
    decision: { type: decisionSchema, default: null },
  },
  { timestamps: true, versionKey: false, minimize: false },
);
schema.index({ reference: 1 }, { unique: true });
schema.index({ status: 1, type: 1 });
schema.index({ createdBy: 1, updatedAt: -1 });
schema.index({ status: 1, updatedAt: -1 });

const RequestModel: Model<RequestDocument> =
  (mongoose.models.Request as Model<RequestDocument> | undefined) ??
  mongoose.model<RequestDocument>('Request', schema);

export interface StepRecord {
  actorId: string; actorRole: Role; action: StepAction; comment: string | null;
  fromStatus: RequestStatus | null; toStatus: RequestStatus; at: Date;
}
export interface RequestRecord {
  id: string; reference: string; type: RequestType; status: RequestStatus; payload: Record<string, unknown>;
  studentId: string | null; createdBy: string; createdByRole: Role; hideIdentity: boolean; workingDays: number | null;
  steps: StepRecord[]; decision: { outcome: DecisionOutcome; decidedBy: string; at: Date } | null;
  createdAt: Date; updatedAt: Date;
}
export interface StepInput {
  actorId: string; actorRole: Role; action: StepAction; comment: string | null;
  fromStatus: RequestStatus | null; toStatus: RequestStatus; at: Date;
}

const OBJECT_ID = /^[a-f0-9]{24}$/;
const toRecord = (r: Row): RequestRecord => ({
  id: r._id.toString(), reference: r.reference, type: r.type, status: r.status, payload: r.payload,
  studentId: r.studentId ? r.studentId.toString() : null, createdBy: r.createdBy.toString(), createdByRole: r.createdByRole,
  hideIdentity: r.hideIdentity, workingDays: r.workingDays ?? null,
  steps: r.steps.map((s) => ({ ...s, actorId: s.actorId.toString() })),
  decision: r.decision ? { outcome: r.decision.outcome, decidedBy: r.decision.decidedBy.toString(), at: r.decision.at } : null,
  createdAt: r.createdAt, updatedAt: r.updatedAt,
});

async function create(data: {
  type: RequestType; payload: Record<string, unknown>; studentId: string | null; createdBy: string;
  createdByRole: Role; hideIdentity: boolean; workingDays: number | null;
}): Promise<RequestRecord> {
  const reference = `REQ-${String(await nextSequence('request')).padStart(6, '0')}`;
  const doc = await RequestModel.create({
    ...data, reference, status: REQUEST_STATUS.DRAFT, decision: null,
    steps: [{ actorId: data.createdBy, actorRole: data.createdByRole, action: 'CREATED', comment: null, fromStatus: null, toStatus: REQUEST_STATUS.DRAFT, at: new Date() }],
  });
  return toRecord(doc.toObject() as Row);
}

async function findById(id: string): Promise<RequestRecord | null> {
  if (!OBJECT_ID.test(id)) return null;
  const row = await RequestModel.findById(id).lean<Row>();
  return row ? toRecord(row) : null;
}

/**
 * Moves a request from one status to another, only if it is still in `from`.
 * Of two people acting at once, only one wins. A request holds at most 200 steps.
 */
async function applyTransition(
  id: string,
  t: { from: RequestStatus; to: RequestStatus; step: StepInput; decision?: { outcome: DecisionOutcome; decidedBy: string; at: Date } },
): Promise<RequestRecord | null> {
  const row = await RequestModel.findOneAndUpdate(
    { _id: id, status: t.from, 'steps.199': { $exists: false } },
    { $set: { status: t.to, ...(t.decision ? { decision: t.decision } : {}) }, $push: { steps: t.step } },
    { new: true },
  ).lean<Row>();
  return row ? toRecord(row) : null;
}

/** Edits a draft or returned request. Only its creator, and only in those two statuses. */
async function editByCreator(
  id: string,
  createdBy: string,
  patch: { payload: Record<string, unknown>; studentId: string | null; hideIdentity: boolean; workingDays: number | null },
  step: StepInput,
): Promise<RequestRecord | null> {
  const row = await RequestModel.findOneAndUpdate(
    { _id: id, createdBy, status: { $in: [REQUEST_STATUS.DRAFT, REQUEST_STATUS.RETURNED] }, 'steps.199': { $exists: false } },
    { $set: patch, $push: { steps: step } },
    { new: true },
  ).lean<Row>();
  return row ? toRecord(row) : null;
}

export interface ListFilter {
  createdBy?: string | undefined;
  /** Reviewer view: everything that has left draft, plus the reviewer's own drafts. */
  reviewerId?: string | undefined;
  excludeCreatedBy?: string | undefined;
  statuses?: RequestStatus[] | undefined;
  type?: RequestType | undefined;
  studentId?: string | undefined;
}

async function list(filter: ListFilter, o: { page: number; limit: number; sort: '-createdAt' | '-updatedAt' }) {
  const query: Record<string, unknown> = {};
  if (filter.createdBy) query.createdBy = filter.createdBy;
  else if (filter.excludeCreatedBy) query.createdBy = { $ne: filter.excludeCreatedBy };
  if (filter.reviewerId) query.$or = [{ status: { $ne: REQUEST_STATUS.DRAFT } }, { createdBy: filter.reviewerId }];
  if (filter.statuses) query.status = { $in: filter.statuses };
  if (filter.type) query.type = filter.type;
  if (filter.studentId) query.studentId = filter.studentId;

  const sortKey = o.sort === '-createdAt' ? 'createdAt' : 'updatedAt';
  const [rows, total] = await Promise.all([
    RequestModel.find(query).sort({ [sortKey]: -1, _id: -1 }).skip(skipOf(o.page, o.limit)).limit(o.limit).lean<Row[]>(),
    RequestModel.countDocuments(query),
  ]);
  return { items: rows.map(toRecord), total };
}

export const requestRepository = { create, findById, applyTransition, editByCreator, list };