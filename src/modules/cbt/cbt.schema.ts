import { z } from 'zod';
import { paginationShape } from '../../common/utils/pagination';
import { PERMISSIONS, ROLES } from '../../config/constants';
import type { OpenApiRegistry } from '../../openapi/registry';
import { DIFFICULTIES, EXAM_STATUS, EXAM_TYPES, MAX_ANSWER_CHARS, MAX_ANSWER_CHARS_PER_REQUEST, MAX_QUESTIONS_PER_STUDENT, QUESTION_TYPES, type ExamStatus } from './cbt.types';

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
  /** Give each student this many questions, drawn at random from the exam's questions. null: everyone sits all of them. */
  questionsPerStudent: z.number().int().min(1).max(MAX_QUESTIONS_PER_STUDENT).nullable().optional(),
});
const settingsView = z.object({
  shuffleQuestions: z.boolean(), shuffleOptions: z.boolean(), resultRelease: z.enum(['IMMEDIATE', 'MANUAL']),
  showAnswers: z.boolean(), passMarkPercent: num, scoreComponent: z.string().nullable(), questionsPerStudent: num.nullable(),
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

/** Loose size limits only: the exact rules, with plain messages, are applied by buildQuestion. */
const questionFields = {
  type: z.enum(QUESTION_TYPES),
  text: z.string().max(5000),
  options: z.array(z.string().max(2000)).max(10).nullable().optional(),
  correctAnswer: z.union([z.string().max(1000), z.array(z.string().max(1000)).max(50)]),
  marks: z.number().optional(),
  topic: z.string().max(500).nullable().optional(),
  difficulty: z.enum(DIFFICULTIES).optional(),
  explanation: z.string().max(5000).nullable().optional(),
  imageFileName: z.string().max(200).nullable().optional(),
};
const addQuestionBody = z.object(questionFields).strict();
const updateQuestionBody = z.object({
  type: questionFields.type.optional(), text: questionFields.text.optional(), options: questionFields.options,
  correctAnswer: questionFields.correctAnswer.optional(), marks: questionFields.marks, topic: questionFields.topic,
  difficulty: questionFields.difficulty, explanation: questionFields.explanation, imageFileName: questionFields.imageFileName,
}).strict().refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
const questionPathParams = z.object({ id: objectId, questionId: objectId });
export const addQuestionSchemas = { params: idParams, body: addQuestionBody };
export const updateQuestionSchemas = { params: questionPathParams, body: updateQuestionBody };
export const deleteQuestionSchemas = { params: questionPathParams };

const uploadImageBody = z.object({ questionId: objectId.optional() }).strict();
export const uploadImageSchemas = { params: idParams, body: uploadImageBody };
export const removeImageSchemas = { params: z.object({ id: objectId, fileName: z.string().trim().min(1).max(100) }) };
const rejectBody = z.object({ reason: z.string().trim().min(3).max(500) });
export const rejectSchemas = { params: idParams, body: rejectBody };

const fmt = (n: number): string => n.toLocaleString('en-US');
/** One answer is limited in length, and so is the whole request. Each message says what was sent and what is allowed. */
const answersMap = z.record(objectId, z.string().nullable()).superRefine((answers, ctx) => {
  let total = 0;
  for (const [questionId, value] of Object.entries(answers)) {
    if (value === null) continue;
    total += value.length;
    if (value.length > MAX_ANSWER_CHARS) {
      ctx.addIssue({ code: 'custom', path: [questionId], message: `This answer is ${fmt(value.length)} characters. The limit is ${fmt(MAX_ANSWER_CHARS)}` });
    }
  }
  if (total > MAX_ANSWER_CHARS_PER_REQUEST) {
    ctx.addIssue({ code: 'custom', message: `This request carries ${fmt(total)} characters of answers. The limit is ${fmt(MAX_ANSWER_CHARS_PER_REQUEST)}. Save fewer answers at a time` });
  }
});
const saveAnswersBody = z.object({ answers: answersMap.refine((a) => Object.keys(a).length <= 200, 'Too many answers in one request') });
export const saveAnswersSchemas = { params: idParams, body: saveAnswersBody };
const submitBody = z.object({ answers: answersMap.optional() });
export const submitAttemptSchemas = { params: idParams, body: submitBody };

// ---- editable upload drafts
const batchParams = z.object({ id: objectId, batchId: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
const batchRowParams = batchParams.extend({ tempId: z.string().regex(/^[a-f0-9]{12}$/) });
export const draftBatchSchemas = { params: batchParams };
export const draftAddSchemas = { params: batchParams, body: addQuestionBody };
export const draftRowSchemas = { params: batchRowParams };
export const draftUpdateSchemas = { params: batchRowParams, body: updateQuestionBody };

// ---- pause and resume
const pauseBody = z.object({ reason: z.string().trim().min(3).max(500).optional() });
export const pauseSchemas = { params: idParams, body: pauseBody };

// ---- retakes
const retakeStatuses = ['PENDING', 'APPROVED', 'REJECTED', 'USED', 'REVOKED'] as const;
const retakeParams = z.object({ id: objectId, retakeId: objectId });
const requestRetakeBody = z.object({ studentIds: z.array(objectId).min(1).max(100), reason: z.string().trim().min(3).max(500) });
const approveRetakeBody = z.object({ expiresAt: iso.optional() });
export const requestRetakeSchemas = { params: idParams, body: requestRetakeBody };
export const examRetakesSchemas = { params: idParams, query: z.object({ status: z.enum(retakeStatuses).optional(), ...paginationShape }) };
export const allRetakesSchemas = { query: z.object({ examId: objectId.optional(), status: z.enum(retakeStatuses).optional(), ...paginationShape }) };
export const approveRetakeSchemas = { params: retakeParams, body: approveRetakeBody };
export const rejectRetakeSchemas = { params: retakeParams, body: rejectBody };
export const revokeRetakeSchemas = { params: retakeParams };
export const studentTrailSchemas = { params: z.object({ id: objectId, studentId: objectId }) };

const examView = z.object({
  id: z.string(), title: z.string(), subjectId: z.string(), subjectName: z.string(),
  classArms: z.array(z.object({ id: z.string(), name: z.string() })), teacherId: z.string(), teacherName: z.string(),
  sessionId: z.string(), termId: z.string(), type: z.enum(EXAM_TYPES), durationMin: num, windowStart: iso, windowEnd: iso,
  instructions: z.string(), settings: settingsView, status: z.enum(statusValues), rejectionReason: z.string().nullable(),
  resultsReleased: z.boolean(), questionCount: num, maxScore: z.number(), maxScorePerStudent: z.number(), createdAt: iso,
  paused: z.boolean(), pausedAt: iso.nullable(), pauseReason: z.string().nullable(),
});
const paperQuestion = z.object({ id: z.string(), type: z.enum(QUESTION_TYPES), text: z.string(), marks: z.number(), options: z.array(z.object({ key: z.string(), text: z.string() })).nullable(),
  imageUrl: z.string().nullable(), imageWidth: num.nullable(), imageHeight: num.nullable() });
const attemptView = z.object({
  attemptId: z.string(), examId: z.string(), title: z.string(), instructions: z.string(), durationMin: num,
  status: z.enum(['IN_PROGRESS', 'SUBMITTED']), startedAt: iso, endsAt: iso, serverTime: iso, remainingSeconds: num,
  answers: z.record(z.string(), z.string()), questions: z.array(paperQuestion),
});
const staffQuestion = z.object({
  id: z.string(), order: num, type: z.enum(QUESTION_TYPES), text: z.string(), options: z.array(z.object({ key: z.string(), text: z.string() })).nullable(),
  correctAnswer: z.union([z.string(), z.array(z.string())]), marks: z.number(), topic: z.string().nullable(), difficulty: z.enum(DIFFICULTIES), explanation: z.string().nullable(),
  imageFileName: z.string().nullable(), imageUrl: z.string().nullable(), imageWidth: num.nullable(), imageHeight: num.nullable(),
});
const issue = z.object({ field: z.string(), issue: z.string() });
const draftRow = z.object({
  tempId: z.string(), row: num.nullable().describe('The line in the uploaded file, or null for a question added by hand'), valid: z.boolean(),
  errors: z.array(issue), warnings: z.array(issue),
  question: z.object({
    type: z.string(), text: z.string(), options: z.array(z.string()).nullable(), correctAnswer: z.union([z.string(), z.array(z.string())]),
    marks: z.number(), topic: z.string().nullable(), difficulty: z.string(), explanation: z.string().nullable(), imageFileName: z.string().nullable(),
  }),
});
const importReport = z.object({
  batchId: z.string().describe('The editable draft. It lasts 24 hours from the upload'), fileName: z.string(), expiresAt: iso, examId: z.string(),
  rowCount: num, validCount: num, errors: z.array(z.object({ row: num, field: z.string(), issue: z.string() })), truncated: z.boolean(),
  warnings: z.array(z.object({ row: num, field: z.string(), issue: z.string() })).describe('Pictures named in the image column that have not been uploaded yet. They do not block the import'),
  totalMarks: z.number().nullable(), byType: z.record(z.string(), num).nullable(),
  preview: z.array(z.object({ type: z.enum(QUESTION_TYPES), text: z.string(), marks: z.number() })),
  importToken: z.string().nullable().describe('Same as batchId once every question is valid, otherwise null'),
  rows: z.array(draftRow).describe('Every question in the draft, each with its own valid flag and errors'),
  problems: z.array(issue).describe('Problems with the set as a whole, for example the questions-per-student setting'),
});

const retakeView = z.object({
  id: z.string(), examId: z.string(), examTitle: z.string(), studentId: z.string(), studentName: z.string(), reason: z.string(),
  status: z.enum(retakeStatuses), attemptNumber: num.describe('The sitting this retake follows'),
  requestedBy: z.string(), requestedByName: z.string(), createdAt: iso,
  decidedBy: z.string().nullable(), decidedByName: z.string().nullable(), decidedAt: iso.nullable(), decisionNote: z.string().nullable(),
  expiresAt: iso.nullable(), usedAt: iso.nullable(),
});
const sitting = z.object({
  attemptNumber: num, attemptId: z.string(), current: z.boolean(), status: z.enum(['IN_PROGRESS', 'SUBMITTED']), startedAt: iso, submittedAt: iso.nullable(),
  score: z.number().nullable(), maxScore: z.number(), percent: z.number().nullable(), autoSubmitted: z.boolean(), supersededAt: iso.nullable(),
  retake: z.object({ id: z.string(), reason: z.string(), requestedBy: z.string(), requestedByName: z.string(), approvedBy: z.string().nullable(), approvedByName: z.string().nullable(), approvedAt: iso.nullable() }).nullable(),
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
  registry.register({ method: 'post', path: '/cbt/exams/{id}/questions/import', operationId: 'importExamQuestions', summary: 'Upload the question CSV (field "file", max 2 MB, 200 questions). An optional image column names a picture uploaded with POST /cbt/exams/{id}/question-images. Validates every row and returns them all as an editable draft (batchId, 24 hours). Saves nothing to the exam until the draft is confirmed', tags, roles: manage, request: { params: idParams }, upload: true, success: done(importReport, 'The draft, with a valid flag and errors on every row'), errors: ['IMPORT_INVALID', 'NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'post', path: '/cbt/exams/{id}/questions/import/confirm', operationId: 'confirmExamQuestions', summary: 'Save a clean upload as the exam\'s questions, replacing any earlier ones', tags, roles: manage, request: { params: idParams, body: confirmBody }, success: done(z.object({ questions: num, maxScore: z.number() }), 'Saved'), errors: ['IMPORT_TOKEN_EXPIRED', 'NOT_FOUND', 'CONFLICT'] });
  const examSummary = z.object({ questionCount: num, maxScore: z.number(), problem: z.object({ field: z.string(), issue: z.string() }).nullable().describe('A heads-up, not a block: for example mixed marks on an exam that gives each student a share of its questions. It must be fixed before the exam is submitted') });
  const questionHow = 'Only while the exam is a draft or rejected, and only the teacher who owns it. The exam\'s question count and total marks are updated with it. A question identical to another in the exam is refused';
  registry.register({ method: 'post', path: '/cbt/exams/{id}/questions', operationId: 'addQuestion', summary: `Add one question to the end of the exam, without uploading a spreadsheet. MCQ: options are the option texts in order (2 to 5, lettered A to E automatically) and correctAnswer is the letter. TRUE_FALSE: correctAnswer is TRUE or FALSE. SHORT_ANSWER: correctAnswer is the list of accepted answers (1 to 10). imageFileName names a picture already uploaded to this exam. ${questionHow}`, tags, roles: manage, request: { params: idParams, body: addQuestionBody }, success: done(z.object({ question: staffQuestion, exam: examSummary }), 'Added', 201), errors: ['VALIDATION_ERROR', 'NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'patch', path: '/cbt/exams/{id}/questions/{questionId}', operationId: 'updateQuestion', summary: `Fix any part of one question: a typo, the correct answer, the marks, an option, its picture (imageFileName, or null to remove it). Only the fields you send change, and the result must still be a valid question. Changing type to one without options drops them. ${questionHow}`, tags, roles: manage, request: { params: questionPathParams, body: updateQuestionBody }, success: done(z.object({ question: staffQuestion, exam: examSummary }), 'Updated'), errors: ['VALIDATION_ERROR', 'NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'delete', path: '/cbt/exams/{id}/questions/{questionId}', operationId: 'deleteQuestion', summary: `Delete one question. The ones after it move up so the numbering has no gap. ${questionHow}`, tags, roles: manage, request: { params: questionPathParams }, success: done(z.object({ exam: examSummary }), 'Deleted'), errors: ['NOT_FOUND', 'CONFLICT'] });
  const imageView = z.object({ fileName: z.string(), url: z.string(), width: num, height: num, bytes: num, questionIds: z.array(z.string()), uploadedAt: iso });
  registry.register({ method: 'get', path: '/cbt/exams/{id}/question-images', operationId: 'listQuestionImages', summary: 'The pictures uploaded to this exam, each with the questions that show it. A picture with no questions is waiting to be matched by an import', tags, roles: manage, request: { params: idParams }, success: done(z.array(imageView), 'Pictures'), errors: ['NOT_FOUND'] });
  registry.register({ method: 'post', path: '/cbt/exams/{id}/question-images', operationId: 'uploadQuestionImage', summary: 'Upload a diagram (field "file", PNG or JPG, max 2 MB, checked by its content). The file name matters: a spreadsheet\'s image column finds pictures by it, and uploading the same name again replaces the picture everywhere it is used. Send questionId to attach it to one question straight away. Shown at most 1600 px wide with its width and height returned. Only while the exam is a draft or rejected', tags, roles: manage, request: { params: idParams, body: uploadImageBody }, upload: true, success: done(imageView, 'Uploaded', 201), errors: ['VALIDATION_ERROR', 'NOT_FOUND', 'CONFLICT', 'SERVICE_UNAVAILABLE'] });
  registry.register({ method: 'delete', path: '/cbt/exams/{id}/question-images/{fileName}', operationId: 'removeQuestionImage', summary: 'Delete a picture. Every question that showed it loses its picture, and the file is removed from the image store. Only while the exam is a draft or rejected', tags, roles: manage, request: { params: removeImageSchemas.params }, success: done(z.null(), 'Removed'), errors: ['NOT_FOUND', 'CONFLICT', 'SERVICE_UNAVAILABLE'] });
  registry.register({ method: 'post', path: '/cbt/exams/{id}/submit-for-approval', operationId: 'submitExam', summary: 'A class test goes live; a term exam goes to an admin for approval', tags, roles: manage, request: { params: idParams }, success: done(examView, 'Submitted'), errors: ['NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'post', path: '/cbt/exams/{id}/approve', operationId: 'approveExam', summary: 'Approve a term exam. It becomes live and students are notified', tags, roles: PERMISSIONS['cbt:approve'], request: { params: idParams }, success: done(examView, 'Approved'), errors: ['NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'post', path: '/cbt/exams/{id}/reject', operationId: 'rejectExam', summary: 'Send a term exam back to the teacher with a reason', tags, roles: PERMISSIONS['cbt:approve'], request: { params: idParams, body: rejectBody }, success: done(examView, 'Rejected'), errors: ['NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'post', path: '/cbt/exams/{id}/release-results', operationId: 'releaseExamResults', summary: 'After the window closes: make results visible and copy scores into the score grid if a component is chosen', tags, roles: manage, request: { params: idParams }, success: done(z.object({ released: z.boolean(), alreadyReleased: z.boolean(), fed: num, skipped: num }), 'Released'), errors: ['NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'get', path: '/cbt/exams/{id}/analytics', operationId: 'getExamAnalytics', summary: 'Average, pass rate, distribution, hardest questions and who has not taken it', tags, roles: PERMISSIONS['cbt:analytics'], request: { params: idParams }, success: done(z.object({ examId: z.string(), title: z.string(), final: z.boolean(), enrolled: num, submitted: num, inProgress: num, notStarted: num, averageScore: z.number().nullable(), averagePercent: z.number().nullable(), highestPercent: z.number().nullable(), lowestPercent: z.number().nullable(), passMarkPercent: num, passRate: z.number().nullable(), distribution: z.array(z.object({ from: z.number(), to: z.number(), count: num })), hardestQuestions: z.array(z.record(z.string(), z.unknown())), questions: z.array(z.record(z.string(), z.unknown())), notTaken: z.array(z.object({ studentId: z.string(), name: z.string(), admissionNo: z.string() })) }), 'Analytics'), errors: ['NOT_FOUND'] });
  registry.register({ method: 'get', path: '/cbt/exams/{id}/attempts', operationId: 'listExamAttempts', summary: 'Live monitoring: who started, progress and who has finished', tags, roles: PERMISSIONS['cbt:analytics'], request: { params: idParams, query: attemptsListSchemas.query }, success: page(z.object({ attemptId: z.string(), studentId: z.string(), studentName: z.string(), admissionNo: z.string(), status: z.enum(['IN_PROGRESS', 'SUBMITTED']), startedAt: iso, endsAt: iso, submittedAt: iso.nullable(), autoSubmitted: z.boolean(), answered: num, questions: num, score: z.number().nullable(), maxScore: z.number() })), errors: ['NOT_FOUND'] });

  registry.register({ method: 'get', path: '/cbt/schedule', operationId: 'getExamSchedule', summary: 'Read-only exam schedule for a student, or for a parent\'s children (optionally one child)', tags, roles: [ROLES.PARENT, ROLES.STUDENT], request: { query: scheduleSchemas.query }, success: done(z.array(z.object({ examId: z.string(), title: z.string(), subjectName: z.string(), type: z.enum(EXAM_TYPES), windowStart: iso, windowEnd: iso, durationMin: num, studentId: z.string(), studentName: z.string(), classArmName: z.string() })), 'The schedule'), errors: ['NOT_FOUND'] });
  registry.register({ method: 'get', path: '/cbt/time', operationId: 'getServerTime', summary: 'Server time, for the connection check and the clock offset', tags, roles: PERMISSIONS['cbt:take'], success: done(z.object({ serverTime: iso }), 'Now') });
  registry.register({ method: 'get', path: '/cbt/my-exams', operationId: 'listMyExams', summary: 'My exams: upcoming, open, in progress, completed or missed', tags, roles: PERMISSIONS['cbt:take'], success: done(z.array(z.object({ id: z.string(), title: z.string(), subjectName: z.string(), type: z.enum(EXAM_TYPES), durationMin: num, windowStart: iso, windowEnd: iso, instructions: z.string(), questionCount: num, state: z.enum(['UPCOMING', 'OPEN', 'IN_PROGRESS', 'COMPLETED', 'MISSED']), attempt: z.object({ id: z.string(), status: z.enum(['IN_PROGRESS', 'SUBMITTED']), endsAt: iso, submittedAt: iso.nullable() }).nullable(), result: z.object({ score: z.number(), maxScore: z.number(), percent: z.number().nullable(), passed: z.boolean() }).nullable(), paused: z.boolean(), retake: z.object({ expiresAt: iso.nullable() }).nullable().describe('Set when an admin approved a retake the student has not used yet. Start the exam to begin it') })), 'My exams') });
  registry.register({ method: 'post', path: '/cbt/exams/{id}/start', operationId: 'startExam', summary: 'Start the exam, or resume it. Returns the shuffled questions without answers, endsAt and serverTime. If the exam gives each student a share of its questions (settings.questionsPerStudent), the student is dealt a random selection when they start, fixed for the whole attempt and identical on every refresh or resume', tags, roles: PERMISSIONS['cbt:take'], request: { params: idParams }, success: done(attemptView, 'Started'), errors: ['NOT_FOUND', 'EXAM_NOT_OPEN', 'EXAM_PAUSED', 'ATTEMPT_EXPIRED', 'ATTEMPT_ALREADY_SUBMITTED', 'CONFLICT'] });
  registry.register({ method: 'get', path: '/cbt/attempts/{id}', operationId: 'getAttempt', summary: 'Resume after a refresh: the paper, the saved answers and the time left', tags, roles: PERMISSIONS['cbt:take'], request: { params: idParams }, success: done(attemptView, 'The attempt'), errors: ['NOT_FOUND', 'EXAM_PAUSED', 'ATTEMPT_EXPIRED', 'ATTEMPT_ALREADY_SUBMITTED'] });
  registry.register({ method: 'put', path: '/cbt/attempts/{id}/answers', operationId: 'saveAnswers', summary: 'Autosave (debounced). Send only changed answers; null clears one. MCQ: the option key. TRUE_FALSE: TRUE or FALSE. SHORT_ANSWER: text, up to 2,000 characters, line breaks kept. One request may carry at most 100,000 characters of answers in total (the body may be up to 512 KB). Over the limit returns VALIDATION_ERROR saying how long the answer was and what is allowed. Send a few long answers at a time, not all at once', tags, roles: PERMISSIONS['cbt:take'], request: { params: idParams, body: saveAnswersBody }, success: done(z.object({ saved: num, paused: z.boolean(), serverTime: iso, remainingSeconds: num }), 'Saved'), errors: ['NOT_FOUND', 'EXAM_PAUSED', 'ATTEMPT_EXPIRED', 'ATTEMPT_ALREADY_SUBMITTED'] });
  registry.register({ method: 'post', path: '/cbt/attempts/{id}/submit', operationId: 'submitAttempt', summary: 'Submit, with optional final answers (same length limits as saving). If answers were already saved, submit without them. Safe to repeat. ATTEMPT_EXPIRED means the server already submitted it', tags, roles: PERMISSIONS['cbt:take'], request: { params: idParams, body: submitBody }, success: done(z.object({ attemptId: z.string(), status: z.enum(['IN_PROGRESS', 'SUBMITTED']), submittedAt: iso.nullable(), resultAvailable: z.boolean(), score: z.number().nullable(), maxScore: z.number().nullable(), percent: z.number().nullable() }), 'Submitted'), errors: ['NOT_FOUND', 'EXAM_PAUSED', 'ATTEMPT_EXPIRED'] });
  registry.register({ method: 'get', path: '/cbt/attempts/{id}/result', operationId: 'getAttemptResult', summary: 'My score, and the answer review if the teacher allowed it. Only once results are visible', tags, roles: PERMISSIONS['cbt:take'], request: { params: idParams }, success: done(z.object({ attemptId: z.string(), examId: z.string(), title: z.string(), score: z.number(), maxScore: z.number(), percent: z.number().nullable(), passed: z.boolean(), passMarkPercent: num, correctCount: num, questionCount: num, submittedAt: iso.nullable(), autoSubmitted: z.boolean(), review: z.array(z.record(z.string(), z.unknown())).nullable() }), 'The result'), errors: ['NOT_FOUND', 'CONFLICT'] });

  // ---- editable upload drafts (the teacher's own, until confirmed or 24 hours pass)
  const draftHow = 'Only the teacher who uploaded it, while the exam is a draft or rejected. Returns the whole draft again, each question with its own valid flag and errors. Nothing reaches the exam until it is confirmed';
  registry.register({ method: 'get', path: '/cbt/exams/{id}/questions/import/{batchId}', operationId: 'getQuestionDraft', summary: `Open an uploaded draft. ${draftHow}`, tags, roles: manage, request: { params: batchParams }, success: done(importReport, 'The draft'), errors: ['IMPORT_TOKEN_EXPIRED', 'NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'post', path: '/cbt/exams/{id}/questions/import/{batchId}/questions', operationId: 'addDraftQuestion', summary: `Add a question, written by hand, to the draft. ${draftHow}`, tags, roles: manage, request: { params: batchParams, body: addQuestionBody }, success: done(importReport, 'The draft', 201), errors: ['VALIDATION_ERROR', 'IMPORT_TOKEN_EXPIRED', 'NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'patch', path: '/cbt/exams/{id}/questions/import/{batchId}/questions/{tempId}', operationId: 'updateDraftQuestion', summary: `Fix any part of one draft question. Only what you send changes. A question that is still wrong is kept and shows its errors. ${draftHow}`, tags, roles: manage, request: { params: batchRowParams, body: updateQuestionBody }, success: done(importReport, 'The draft'), errors: ['VALIDATION_ERROR', 'IMPORT_TOKEN_EXPIRED', 'NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'delete', path: '/cbt/exams/{id}/questions/import/{batchId}/questions/{tempId}', operationId: 'deleteDraftQuestion', summary: `Remove one question from the draft. ${draftHow}`, tags, roles: manage, request: { params: batchRowParams }, success: done(importReport, 'The draft'), errors: ['IMPORT_TOKEN_EXPIRED', 'NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'post', path: '/cbt/exams/{id}/questions/import/{batchId}/confirm', operationId: 'confirmQuestionDraft', summary: 'Save the draft as the exam\'s questions, replacing any earlier ones. Refused, with the list of problems, while any question is invalid', tags, roles: manage, request: { params: batchParams }, success: done(z.object({ questions: num, maxScore: z.number() }), 'Saved'), errors: ['IMPORT_INVALID', 'IMPORT_TOKEN_EXPIRED', 'NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'delete', path: '/cbt/exams/{id}/questions/import/{batchId}', operationId: 'discardQuestionDraft', summary: 'Throw the draft away. The exam is untouched', tags, roles: manage, request: { params: batchParams }, success: done(z.null(), 'Discarded'), errors: ['IMPORT_TOKEN_EXPIRED', 'NOT_FOUND', 'CONFLICT'] });

  // ---- pause and resume
  const who = 'The teacher who owns the exam, an admin or the super admin';
  registry.register({ method: 'post', path: '/cbt/exams/{id}/pause', operationId: 'pauseExam', summary: `Stop the exam\'s clock. While paused nobody can start, save or submit (EXAM_PAUSED); saved answers are kept. ${who}`, tags, roles: PERMISSIONS['cbt:analytics'], request: { params: idParams, body: pauseBody }, success: done(z.object({ examId: z.string(), paused: z.boolean(), pausedAt: iso, reason: z.string().nullable() }), 'Paused'), errors: ['NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'post', path: '/cbt/exams/{id}/resume', operationId: 'resumeExam', summary: `Start the clock again. Every running attempt, and the exam\'s window end, move forward by the length of the pause, so it costs nobody time. ${who}`, tags, roles: PERMISSIONS['cbt:analytics'], request: { params: idParams }, success: done(z.object({ examId: z.string(), paused: z.boolean(), pausedMs: num, attemptsExtended: num, windowEnd: iso }), 'Resumed'), errors: ['NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'get', path: '/cbt/exams/{id}/status', operationId: 'getExamStatus', summary: 'Is the exam running or paused? A student\'s screen polls this (every 15 to 30 seconds) to show the paused notice. For a student it also carries their time left, frozen while paused', tags, roles: PERMISSIONS['cbt:read'], request: { params: idParams }, success: done(z.object({ examId: z.string(), paused: z.boolean(), pausedAt: iso.nullable(), reason: z.string().nullable(), windowEnd: iso, serverTime: iso, attempt: z.object({ id: z.string(), status: z.enum(['IN_PROGRESS', 'SUBMITTED']), remainingSeconds: num }).nullable() }), 'The status'), errors: ['NOT_FOUND', 'FORBIDDEN'] });
  registry.register({ method: 'get', path: '/cbt/exams/{id}/pause-history', operationId: 'getExamPauseHistory', summary: `Every pause: who paused, why, who resumed, and how long it lasted. ${who}`, tags, roles: PERMISSIONS['cbt:analytics'], request: { params: idParams }, success: done(z.array(z.object({ id: z.string(), pausedAt: iso, pausedBy: z.string(), pausedByName: z.string(), reason: z.string().nullable(), resumedAt: iso.nullable(), resumedBy: z.string().nullable(), resumedByName: z.string().nullable(), extendedSeconds: num.nullable() })), 'The pauses'), errors: ['NOT_FOUND'] });

  // ---- retakes
  const retakeRules = 'A retake needs the teacher\'s request and an admin\'s approval, and an approval can be used once. It is not possible after results have been released';
  registry.register({ method: 'post', path: '/cbt/exams/{id}/retakes', operationId: 'requestExamRetakes', summary: `Ask for a retake for one or more students who finished the exam (they failed badly, or a fault spoiled it), with a reason. Students who cannot be included come back in skipped. ${retakeRules}`, tags, roles: manage, request: { params: idParams, body: requestRetakeBody }, success: done(z.object({ requested: z.array(retakeView), skipped: z.array(z.object({ studentId: z.string(), reason: z.string() })) }), 'Requested', 201), errors: ['VALIDATION_ERROR', 'NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'get', path: '/cbt/exams/{id}/retakes', operationId: 'listExamRetakes', summary: 'Retake requests for one exam. Teachers see the ones they made; admins see all', tags, roles: PERMISSIONS['cbt:analytics'], request: { params: idParams, query: examRetakesSchemas.query }, success: page(retakeView), errors: ['NOT_FOUND'] });
  registry.register({ method: 'get', path: '/cbt/retakes', operationId: 'listRetakes', summary: 'Retake requests across exams. Admins use status=PENDING as their approval queue; teachers see the ones they made', tags, roles: PERMISSIONS['cbt:analytics'], request: { query: allRetakesSchemas.query }, success: page(retakeView), errors: ['NOT_FOUND'] });
  registry.register({ method: 'post', path: '/cbt/exams/{id}/retakes/{retakeId}/approve', operationId: 'approveExamRetake', summary: 'Approve a request (admin). The student is told. expiresAt is optional: the last moment they may start. When they start, their earlier sitting moves to the attempt history and a new one, with a newly dealt paper, replaces it', tags, roles: PERMISSIONS['cbt:approve'], request: { params: retakeParams, body: approveRetakeBody }, success: done(retakeView, 'Approved'), errors: ['VALIDATION_ERROR', 'NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'post', path: '/cbt/exams/{id}/retakes/{retakeId}/reject', operationId: 'rejectExamRetake', summary: 'Refuse a request (admin), with a reason the teacher will see', tags, roles: PERMISSIONS['cbt:approve'], request: { params: retakeParams, body: rejectBody }, success: done(retakeView, 'Refused'), errors: ['VALIDATION_ERROR', 'NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'delete', path: '/cbt/exams/{id}/retakes/{retakeId}', operationId: 'revokeExamRetake', summary: 'The teacher withdraws a request that is waiting. An admin can also cancel an approval nobody has used yet', tags, roles: PERMISSIONS['cbt:analytics'], request: { params: retakeParams }, success: done(z.null(), 'Withdrawn'), errors: ['NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'get', path: '/cbt/exams/{id}/students/{studentId}/attempts', operationId: 'getStudentAttemptTrail', summary: 'Every sitting a student has had of this exam, oldest first, with the reason and approver of each retake. Staff only: parents and students never see earlier sittings', tags, roles: PERMISSIONS['cbt:analytics'], request: { params: studentTrailSchemas.params }, success: done(z.object({ examId: z.string(), studentId: z.string(), studentName: z.string(), attempts: z.array(sitting), requests: z.array(retakeView) }), 'The trail'), errors: ['NOT_FOUND'] });
}