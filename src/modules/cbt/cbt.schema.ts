import { z } from 'zod';
import { paginationShape } from '../../common/utils/pagination';
import { PERMISSIONS, ROLES } from '../../config/constants';
import type { OpenApiRegistry } from '../../openapi/registry';
import { DIFFICULTIES, EXAM_STATUS, EXAM_TYPES, QUESTION_TYPES, type ExamStatus } from './cbt.types';

const objectId = z.string().regex(/^[a-f0-9]{24}$/);
const idParams = z.object({ id: objectId });
const iso = z.iso.datetime();
const statusValues = Object.values(EXAM_STATUS) as [ExamStatus, ...ExamStatus[]];
const num = z.number().int();

const settingsInput = z.object({
  shuffleQuestions: z.boolean().optional(), shuffleOptions: z.boolean().optional(),
  resultRelease: z.enum(['IMMEDIATE', 'MANUAL']).optional(), showAnswers: z.boolean().optional(),
  passMarkPercent: z.number().int().min(0).max(100).optional(),
  scoreComponent: z.string().regex(/^[A-Z][A-Z0-9]{0,7}$/).nullable().optional(),
});
const settingsView = z.object({
  shuffleQuestions: z.boolean(), shuffleOptions: z.boolean(), resultRelease: z.enum(['IMMEDIATE', 'MANUAL']),
  showAnswers: z.boolean(), passMarkPercent: num, scoreComponent: z.string().nullable(),
});

const examFields = {
  title: z.string().trim().min(3).max(150), subjectId: objectId, classArmIds: z.array(objectId).min(1).max(10),
  type: z.enum(EXAM_TYPES), durationMin: z.number().int().min(5).max(240),
  windowStart: iso, windowEnd: iso, instructions: z.string().trim().max(2000).optional(), settings: settingsInput.optional(),
};
const createBody = z.object(examFields);
const updateBody = z.object({
  title: examFields.title.optional(), subjectId: objectId.optional(), classArmIds: examFields.classArmIds.optional(),
  type: examFields.type.optional(), durationMin: examFields.durationMin.optional(), windowStart: iso.optional(),
  windowEnd: iso.optional(), instructions: examFields.instructions, settings: settingsInput.optional(),
});
export const createExamSchemas = { body: createBody };
export const updateExamSchemas = { params: idParams, body: updateBody };
export const examIdSchemas = { params: idParams };

export const listExamsQuery = z.object({
  ...paginationShape,
  status: z.enum(statusValues).optional(), type: z.enum(EXAM_TYPES).optional(), subjectId: objectId.optional(),
  classArmId: objectId.optional(), from: iso.optional(), to: iso.optional(),
});
export const listExamsSchemas = { query: listExamsQuery };
export const scheduleSchemas = { query: z.object({ studentId: objectId.optional() }) };
export const attemptsListSchemas = { params: idParams, query: z.object({ ...paginationShape }) };

const confirmBody = z.object({ importToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
export const confirmQuestionsSchemas = { params: idParams, body: confirmBody };
const rejectBody = z.object({ reason: z.string().trim().min(3).max(500) });
export const rejectSchemas = { params: idParams, body: rejectBody };

const answersMap = z.record(objectId, z.string().max(200).nullable());
const saveAnswersBody = z.object({ answers: answersMap.refine((a) => Object.keys(a).length <= 200, 'Too many answers in one request') });
export const saveAnswersSchemas = { params: idParams, body: saveAnswersBody };
const submitBody = z.object({ answers: answersMap.optional() });
export const submitAttemptSchemas = { params: idParams, body: submitBody };

const examView = z.object({
  id: z.string(), title: z.string(), subjectId: z.string(), subjectName: z.string(),
  classArms: z.array(z.object({ id: z.string(), name: z.string() })), teacherId: z.string(), teacherName: z.string(),
  sessionId: z.string(), termId: z.string(), type: z.enum(EXAM_TYPES), durationMin: num, windowStart: iso, windowEnd: iso,
  instructions: z.string(), settings: settingsView, status: z.enum(statusValues), rejectionReason: z.string().nullable(),
  resultsReleased: z.boolean(), questionCount: num, maxScore: z.number(), createdAt: iso,
});
const paperQuestion = z.object({ id: z.string(), type: z.enum(QUESTION_TYPES), text: z.string(), marks: z.number(), options: z.array(z.object({ key: z.string(), text: z.string() })).nullable() });
const attemptView = z.object({
  attemptId: z.string(), examId: z.string(), title: z.string(), instructions: z.string(), durationMin: num,
  status: z.enum(['IN_PROGRESS', 'SUBMITTED']), startedAt: iso, endsAt: iso, serverTime: iso, remainingSeconds: num,
  answers: z.record(z.string(), z.string()), questions: z.array(paperQuestion),
});
const staffQuestion = z.object({
  id: z.string(), order: num, type: z.enum(QUESTION_TYPES), text: z.string(), options: z.array(z.object({ key: z.string(), text: z.string() })).nullable(),
  correctAnswer: z.union([z.string(), z.array(z.string())]), marks: z.number(), topic: z.string().nullable(), difficulty: z.enum(DIFFICULTIES), explanation: z.string().nullable(),
});
const importReport = z.object({
  rowCount: num, validCount: num, errors: z.array(z.object({ row: num, field: z.string(), issue: z.string() })), truncated: z.boolean(),
  totalMarks: z.number().nullable(), byType: z.record(z.string(), num).nullable(),
  preview: z.array(z.object({ type: z.enum(QUESTION_TYPES), text: z.string(), marks: z.number() })), importToken: z.string().nullable(),
});

export function registerCbtOperations(registry: OpenApiRegistry): void {
  const tags = ['cbt'];
  const done = (data: z.ZodType, description = 'Done', status = 200) => ({ status, description, data });
  const page = (data: z.ZodType) => ({ status: 200, description: 'A page', data: z.array(data), paginated: true as const });
  const manage = PERMISSIONS['cbt:manage'];
  const staff = [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.TEACHER];

  registry.register({ method: 'get', path: '/cbt/template.csv', operationId: 'getQuestionTemplate', summary: 'Download the question file template', tags, roles: manage, binaryResponse: 'text/csv', success: done(z.null(), 'The template') });
  registry.register({ method: 'post', path: '/cbt/exams', operationId: 'createExam', summary: 'Create a draft exam. Subject and classes must be ones you teach; the window must fall inside a term of the current session', tags, roles: manage, request: { body: createBody }, success: done(examView, 'Created', 201), errors: ['CONFLICT'] });
  registry.register({ method: 'get', path: '/cbt/exams', operationId: 'listExams', summary: 'Exams. Teachers see their own, admins and the super admin see all. Use status=PENDING_APPROVAL for the approval queue', tags, roles: staff, request: { query: listExamsQuery }, success: page(examView) });
  registry.register({ method: 'get', path: '/cbt/exams/{id}', operationId: 'getExam', summary: 'One exam', tags, roles: staff, request: { params: idParams }, success: done(examView, 'Found'), errors: ['NOT_FOUND'] });
  registry.register({ method: 'patch', path: '/cbt/exams/{id}', operationId: 'updateExam', summary: 'Change a draft or rejected exam (owner only)', tags, roles: manage, request: { params: idParams, body: updateBody }, success: done(examView, 'Updated'), errors: ['NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'delete', path: '/cbt/exams/{id}', operationId: 'deleteExam', summary: 'Delete an exam nobody has started (the owner or an admin)', tags, roles: [ROLES.ADMIN, ROLES.TEACHER], request: { params: idParams }, success: done(z.null(), 'Deleted'), errors: ['NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'get', path: '/cbt/exams/{id}/questions', operationId: 'listExamQuestions', summary: 'The questions with their correct answers, for the owner and admins to review', tags, roles: PERMISSIONS['cbt:analytics'], request: { params: idParams }, success: done(z.array(staffQuestion), 'Questions'), errors: ['NOT_FOUND'] });
  registry.register({ method: 'post', path: '/cbt/exams/{id}/questions/import', operationId: 'importExamQuestions', summary: 'Upload the question CSV (field "file", max 2 MB, 200 questions). Validates every row; saves nothing', tags, roles: manage, request: { params: idParams }, upload: true, success: done(importReport, 'Validation report'), errors: ['IMPORT_INVALID', 'NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'post', path: '/cbt/exams/{id}/questions/import/confirm', operationId: 'confirmExamQuestions', summary: 'Save a clean upload as the exam\'s questions, replacing any earlier ones', tags, roles: manage, request: { params: idParams, body: confirmBody }, success: done(z.object({ questions: num, maxScore: z.number() }), 'Saved'), errors: ['IMPORT_TOKEN_EXPIRED', 'NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'post', path: '/cbt/exams/{id}/submit-for-approval', operationId: 'submitExam', summary: 'A class test goes live; a term exam goes to an admin for approval', tags, roles: manage, request: { params: idParams }, success: done(examView, 'Submitted'), errors: ['NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'post', path: '/cbt/exams/{id}/approve', operationId: 'approveExam', summary: 'Approve a term exam. It becomes live and students are notified', tags, roles: PERMISSIONS['cbt:approve'], request: { params: idParams }, success: done(examView, 'Approved'), errors: ['NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'post', path: '/cbt/exams/{id}/reject', operationId: 'rejectExam', summary: 'Send a term exam back to the teacher with a reason', tags, roles: PERMISSIONS['cbt:approve'], request: { params: idParams, body: rejectBody }, success: done(examView, 'Rejected'), errors: ['NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'post', path: '/cbt/exams/{id}/release-results', operationId: 'releaseExamResults', summary: 'After the window closes: make results visible and copy scores into the score grid if a component is chosen', tags, roles: manage, request: { params: idParams }, success: done(z.object({ released: z.boolean(), alreadyReleased: z.boolean(), fed: num, skipped: num }), 'Released'), errors: ['NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'get', path: '/cbt/exams/{id}/analytics', operationId: 'getExamAnalytics', summary: 'Average, pass rate, distribution, hardest questions and who has not taken it', tags, roles: PERMISSIONS['cbt:analytics'], request: { params: idParams }, success: done(z.object({ examId: z.string(), title: z.string(), final: z.boolean(), enrolled: num, submitted: num, inProgress: num, notStarted: num, averageScore: z.number().nullable(), averagePercent: z.number().nullable(), highestPercent: z.number().nullable(), lowestPercent: z.number().nullable(), passMarkPercent: num, passRate: z.number().nullable(), distribution: z.array(z.object({ from: z.number(), to: z.number(), count: num })), hardestQuestions: z.array(z.record(z.string(), z.unknown())), questions: z.array(z.record(z.string(), z.unknown())), notTaken: z.array(z.object({ studentId: z.string(), name: z.string(), admissionNo: z.string() })) }), 'Analytics'), errors: ['NOT_FOUND'] });
  registry.register({ method: 'get', path: '/cbt/exams/{id}/attempts', operationId: 'listExamAttempts', summary: 'Live monitoring: who started, progress and who has finished', tags, roles: PERMISSIONS['cbt:analytics'], request: { params: idParams, query: attemptsListSchemas.query }, success: page(z.object({ attemptId: z.string(), studentId: z.string(), studentName: z.string(), admissionNo: z.string(), status: z.enum(['IN_PROGRESS', 'SUBMITTED']), startedAt: iso, endsAt: iso, submittedAt: iso.nullable(), autoSubmitted: z.boolean(), answered: num, questions: num, score: z.number().nullable(), maxScore: z.number() })), errors: ['NOT_FOUND'] });

  registry.register({ method: 'get', path: '/cbt/schedule', operationId: 'getExamSchedule', summary: 'Read-only exam schedule for a student, or for a parent\'s children (optionally one child)', tags, roles: [ROLES.PARENT, ROLES.STUDENT], request: { query: scheduleSchemas.query }, success: done(z.array(z.object({ examId: z.string(), title: z.string(), subjectName: z.string(), type: z.enum(EXAM_TYPES), windowStart: iso, windowEnd: iso, durationMin: num, studentId: z.string(), studentName: z.string(), classArmName: z.string() })), 'The schedule'), errors: ['NOT_FOUND'] });
  registry.register({ method: 'get', path: '/cbt/time', operationId: 'getServerTime', summary: 'Server time, for the connection check and the clock offset', tags, roles: PERMISSIONS['cbt:take'], success: done(z.object({ serverTime: iso }), 'Now') });
  registry.register({ method: 'get', path: '/cbt/my-exams', operationId: 'listMyExams', summary: 'My exams: upcoming, open, in progress, completed or missed', tags, roles: PERMISSIONS['cbt:take'], success: done(z.array(z.object({ id: z.string(), title: z.string(), subjectName: z.string(), type: z.enum(EXAM_TYPES), durationMin: num, windowStart: iso, windowEnd: iso, instructions: z.string(), questionCount: num, state: z.enum(['UPCOMING', 'OPEN', 'IN_PROGRESS', 'COMPLETED', 'MISSED']), attempt: z.object({ id: z.string(), status: z.enum(['IN_PROGRESS', 'SUBMITTED']), endsAt: iso, submittedAt: iso.nullable() }).nullable(), result: z.object({ score: z.number(), maxScore: z.number(), percent: z.number().nullable(), passed: z.boolean() }).nullable() })), 'My exams') });
  registry.register({ method: 'post', path: '/cbt/exams/{id}/start', operationId: 'startExam', summary: 'Start the exam, or resume it. Returns the shuffled questions without answers, endsAt and serverTime', tags, roles: PERMISSIONS['cbt:take'], request: { params: idParams }, success: done(attemptView, 'Started'), errors: ['NOT_FOUND', 'EXAM_NOT_OPEN', 'ATTEMPT_EXPIRED', 'ATTEMPT_ALREADY_SUBMITTED'] });
  registry.register({ method: 'get', path: '/cbt/attempts/{id}', operationId: 'getAttempt', summary: 'Resume after a refresh: the paper, the saved answers and the time left', tags, roles: PERMISSIONS['cbt:take'], request: { params: idParams }, success: done(attemptView, 'The attempt'), errors: ['NOT_FOUND', 'ATTEMPT_EXPIRED', 'ATTEMPT_ALREADY_SUBMITTED'] });
  registry.register({ method: 'put', path: '/cbt/attempts/{id}/answers', operationId: 'saveAnswers', summary: 'Autosave (debounced). Send only changed answers; null clears one. MCQ: the option key. TRUE_FALSE: TRUE or FALSE. SHORT_ANSWER: text', tags, roles: PERMISSIONS['cbt:take'], request: { params: idParams, body: saveAnswersBody }, success: done(z.object({ saved: num, serverTime: iso, remainingSeconds: num }), 'Saved'), errors: ['NOT_FOUND', 'ATTEMPT_EXPIRED', 'ATTEMPT_ALREADY_SUBMITTED'] });
  registry.register({ method: 'post', path: '/cbt/attempts/{id}/submit', operationId: 'submitAttempt', summary: 'Submit, with optional final answers. Safe to repeat. ATTEMPT_EXPIRED means the server already submitted it', tags, roles: PERMISSIONS['cbt:take'], request: { params: idParams, body: submitBody }, success: done(z.object({ attemptId: z.string(), status: z.enum(['IN_PROGRESS', 'SUBMITTED']), submittedAt: iso.nullable(), resultAvailable: z.boolean(), score: z.number().nullable(), maxScore: z.number().nullable(), percent: z.number().nullable() }), 'Submitted'), errors: ['NOT_FOUND', 'ATTEMPT_EXPIRED'] });
  registry.register({ method: 'get', path: '/cbt/attempts/{id}/result', operationId: 'getAttemptResult', summary: 'My score, and the answer review if the teacher allowed it. Only once results are visible', tags, roles: PERMISSIONS['cbt:take'], request: { params: idParams }, success: done(z.object({ attemptId: z.string(), examId: z.string(), title: z.string(), score: z.number(), maxScore: z.number(), percent: z.number().nullable(), passed: z.boolean(), passMarkPercent: num, correctCount: num, questionCount: num, submittedAt: iso.nullable(), autoSubmitted: z.boolean(), review: z.array(z.record(z.string(), z.unknown())).nullable() }), 'The result'), errors: ['NOT_FOUND', 'CONFLICT'] });
}