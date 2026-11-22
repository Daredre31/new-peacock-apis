import mongoose, { type ClientSession, type Model, type Types } from 'mongoose';
import { DIFFICULTIES, QUESTION_TYPES, type Difficulty, type QuestionType } from './cbt.types';
import type { PaperQuestion, StoredQuestion } from './grading';

interface QuestionDocument {
  examId: Types.ObjectId; /** Absent on a question added by hand. */
  importBatchId?: Types.ObjectId; order: number; type: QuestionType; text: string;
  options: { key: string; text: string }[]; correctAnswer: string | string[]; marks: number;
  topic: string | null; difficulty: Difficulty; explanation: string | null; hash: string;
  image?: { fileName: string; url: string; width: number; height: number } | null;
}
type Row = QuestionDocument & { _id: Types.ObjectId };

const questionSchema = new mongoose.Schema<QuestionDocument>(
  {
    examId: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', required: true },
    importBatchId: { type: mongoose.Schema.Types.ObjectId },
    order: { type: Number, required: true },
    type: { type: String, enum: QUESTION_TYPES, required: true },
    text: { type: String, required: true, maxlength: 1000 },
    options: { type: [{ key: String, text: String, _id: false }], default: [] },
    correctAnswer: { type: mongoose.Schema.Types.Mixed, required: true },
    marks: { type: Number, required: true },
    topic: { type: String, default: null }, difficulty: { type: String, enum: DIFFICULTIES, default: 'MEDIUM' },
    explanation: { type: String, default: null }, hash: { type: String, required: true },
    image: { type: { fileName: String, url: String, width: Number, height: Number, _id: false }, default: null },
  },
  { versionKey: false, minimize: false },
);
questionSchema.index({ examId: 1, order: 1 });
questionSchema.index({ examId: 1, hash: 1 }, { unique: true });

interface BatchDocument { examId: Types.ObjectId; ownerId: Types.ObjectId; kind: 'QUESTIONS'; fileName: string; rowCount: number; status: 'CONFIRMED'; createdAt: Date }
const batchSchema = new mongoose.Schema<BatchDocument>(
  {
    examId: { type: mongoose.Schema.Types.ObjectId, required: true },
    ownerId: { type: mongoose.Schema.Types.ObjectId, required: true },
    kind: { type: String, default: 'QUESTIONS' }, fileName: { type: String, maxlength: 200 },
    rowCount: Number, status: { type: String, default: 'CONFIRMED' },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
batchSchema.index({ examId: 1 });

const QuestionModel: Model<QuestionDocument> =
  (mongoose.models.Question as Model<QuestionDocument> | undefined) ?? mongoose.model<QuestionDocument>('Question', questionSchema);
const BatchModel: Model<BatchDocument> =
  (mongoose.models.ImportBatch as Model<BatchDocument> | undefined) ?? mongoose.model<BatchDocument>('ImportBatch', batchSchema);

/** `imageFile` is the file name a spreadsheet row asked for. It is resolved to a stored picture when the import is confirmed. */
export type NewQuestion = Omit<StoredQuestion, 'id' | 'order'> & { hash: string; imageFile?: string | null };

const toStored = (r: Row): StoredQuestion => ({
  id: r._id.toString(), order: r.order, type: r.type, text: r.text, options: r.options.length > 0 ? r.options : null,
  correctAnswer: r.correctAnswer, marks: r.marks, topic: r.topic ?? null, difficulty: r.difficulty, explanation: r.explanation ?? null,
  imageFileName: r.image?.fileName ?? null, imageUrl: r.image?.url ?? null, imageWidth: r.image?.width ?? null, imageHeight: r.image?.height ?? null,
});

/** Replaces the exam's whole question set with one new batch. Runs inside the caller's transaction. */
async function replaceAll(examId: string, ownerId: string, fileName: string, questions: NewQuestion[], session: ClientSession) {
  await QuestionModel.deleteMany({ examId }, { session });
  await BatchModel.deleteMany({ examId }, { session });
  const [batch] = await BatchModel.create([{ examId, ownerId, fileName, rowCount: questions.length }], { session });
  if (!batch) throw new Error('Import batch was not created');

  await QuestionModel.insertMany(
    questions.map((q, order) => ({
      examId, importBatchId: batch._id, order, type: q.type, text: q.text, options: q.options ?? [],
      correctAnswer: q.correctAnswer, marks: q.marks, topic: q.topic, difficulty: q.difficulty, explanation: q.explanation, hash: q.hash,
      image: q.imageUrl && q.imageFileName ? { fileName: q.imageFileName, url: q.imageUrl, width: q.imageWidth ?? 0, height: q.imageHeight ?? 0 } : null,
    })),
    { session },
  );
  return { count: questions.length, maxScore: Math.round(questions.reduce((s, q) => s + q.marks, 0) * 10) / 10 };
}

async function forExamWithKey(examId: string): Promise<StoredQuestion[]> {
  const rows = await QuestionModel.find({ examId }).sort({ order: 1 }).lean<Row[]>();
  return rows.map(toStored);
}

/** The paper as students see it: no correct answers, no explanations. */
async function paperOf(examId: string): Promise<PaperQuestion[]> {
  return (await forExamWithKey(examId)).map((q) => ({
    id: q.id, type: q.type, text: q.text, options: q.options, marks: q.marks,
    imageUrl: q.imageUrl ?? null, imageWidth: q.imageWidth ?? null, imageHeight: q.imageHeight ?? null,
  }));
}

/** A question as the teacher will save it: validated, with its picture (if any) already looked up. */
export interface QuestionToSave {
  type: QuestionType; text: string; options: { key: string; text: string }[] | null; correctAnswer: string | string[];
  marks: number; topic: string | null; difficulty: Difficulty; explanation: string | null; hash: string;
  image: { fileName: string; url: string; width: number; height: number } | null;
}
const body = (q: QuestionToSave) => ({
  type: q.type, text: q.text, options: q.options ?? [], correctAnswer: q.correctAnswer, marks: q.marks, topic: q.topic,
  difficulty: q.difficulty, explanation: q.explanation, hash: q.hash, image: q.image,
});

async function findOne(examId: string, questionId: string): Promise<StoredQuestion | null> {
  if (!/^[a-f0-9]{24}$/.test(questionId)) return null;
  const row = await QuestionModel.findOne({ _id: questionId, examId }).lean<Row>();
  return row ? toStored(row) : null;
}

/** Adds one question at the end. The caller runs this in a transaction with the exam's totals. */
async function insertOne(examId: string, q: QuestionToSave, session: ClientSession): Promise<StoredQuestion> {
  const last = await QuestionModel.findOne({ examId }, { order: 1 }).sort({ order: -1 }).session(session).lean<Row>();
  const [doc] = await QuestionModel.create([{ examId, order: last ? last.order + 1 : 0, ...body(q) }], { session });
  if (!doc) throw new Error('Question was not saved');
  return toStored(doc.toObject() as Row);
}

async function replaceOne(examId: string, questionId: string, q: QuestionToSave, session: ClientSession): Promise<StoredQuestion | null> {
  const row = await QuestionModel.findOneAndUpdate({ _id: questionId, examId }, { $set: body(q) }, { new: true, session }).lean<Row>();
  return row ? toStored(row) : null;
}

/** Deletes one question and closes the gap it leaves, so the numbering stays 1, 2, 3 with no holes. */
async function deleteOne(examId: string, questionId: string, session: ClientSession): Promise<boolean> {
  const done = await QuestionModel.deleteOne({ _id: questionId, examId }, { session });
  if (done.deletedCount === 0) return false;
  const rest = await QuestionModel.find({ examId }, { order: 1 }).sort({ order: 1 }).session(session).lean<Row[]>();
  const moves = rest.flatMap((r, i) => (r.order === i ? [] : [{ updateOne: { filter: { _id: r._id }, update: { $set: { order: i } } } }]));
  if (moves.length > 0) await QuestionModel.bulkWrite(moves, { session, ordered: true });
  return true;
}

/** What the exam now holds, worked out from the questions themselves so it can never drift from them. */
async function totals(examId: string, session: ClientSession): Promise<{ count: number; maxScore: number }> {
  const [row] = await QuestionModel.aggregate<{ count: number; marks: number }>([
    { $match: { examId: new mongoose.Types.ObjectId(examId) } },
    { $group: { _id: null, count: { $sum: 1 }, marks: { $sum: '$marks' } } },
  ]).session(session);
  return { count: row?.count ?? 0, maxScore: Math.round((row?.marks ?? 0) * 10) / 10 };
}

/** The different mark values among an exam's questions. */
async function distinctMarks(examId: string): Promise<number[]> {
  return (await QuestionModel.distinct('marks', { examId })) as number[];
}

type ImageFields = { fileName: string; url: string; width: number; height: number };

/** Does this question belong to this exam? Guards against attaching a picture to someone else's question. */
async function hasQuestion(examId: string, questionId: string): Promise<boolean> {
  if (!/^[a-f0-9]{24}$/.test(questionId)) return false;
  return (await QuestionModel.exists({ _id: questionId, examId })) !== null;
}
async function attachImage(examId: string, questionId: string, image: ImageFields, session: ClientSession): Promise<boolean> {
  const result = await QuestionModel.updateOne({ _id: questionId, examId }, { $set: { image } }, { session });
  return result.matchedCount > 0;
}
/** A picture was uploaded again under the same name: every question using it gets the new address and size. */
async function refreshImage(examId: string, image: ImageFields, session: ClientSession): Promise<void> {
  await QuestionModel.updateMany({ examId, 'image.fileName': image.fileName }, { $set: { image } }, { session });
}
async function clearImage(examId: string, fileName: string, session: ClientSession): Promise<void> {
  await QuestionModel.updateMany({ examId, 'image.fileName': fileName }, { $set: { image: null } }, { session });
}
/** Which questions use which picture, by file name. */
async function imageLinks(examId: string): Promise<Map<string, string[]>> {
  const rows = await QuestionModel.find({ examId, 'image.fileName': { $exists: true, $ne: null } }, { image: 1 }).sort({ order: 1 }).lean<Row[]>();
  const links = new Map<string, string[]>();
  for (const r of rows) {
    const name = r.image?.fileName;
    if (name) links.set(name, [...(links.get(name) ?? []), r._id.toString()]);
  }
  return links;
}

async function removeForExam(examId: string): Promise<void> {
  await QuestionModel.deleteMany({ examId });
  await BatchModel.deleteMany({ examId });
}

export const questionRepository = { replaceAll, forExamWithKey, paperOf, removeForExam, distinctMarks, findOne, insertOne, replaceOne, deleteOne, totals, hasQuestion, attachImage, refreshImage, clearImage, imageLinks };