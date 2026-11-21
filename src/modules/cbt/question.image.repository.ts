import mongoose, { type ClientSession, type Model, type Types } from 'mongoose';

interface ImageDocument {
  examId: Types.ObjectId;
  /** Lower-case file name as the teacher uploaded it. A spreadsheet cell names the picture by this. */
  fileName: string;
  publicId: string;
  url: string;
  width: number;
  height: number;
  bytes: number;
  uploadedBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}
type Row = ImageDocument & { _id: Types.ObjectId };

const imageSchema = new mongoose.Schema<ImageDocument>(
  {
    examId: { type: mongoose.Schema.Types.ObjectId, ref: 'Exam', required: true },
    fileName: { type: String, required: true, maxlength: 80 },
    publicId: { type: String, required: true },
    url: { type: String, required: true },
    width: { type: Number, required: true },
    height: { type: Number, required: true },
    bytes: { type: Number, required: true },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, required: true },
  },
  { timestamps: true, versionKey: false },
);
imageSchema.index({ examId: 1, fileName: 1 }, { unique: true });

const ImageModel: Model<ImageDocument> =
  (mongoose.models.QuestionImage as Model<ImageDocument> | undefined) ?? mongoose.model<ImageDocument>('QuestionImage', imageSchema);

export interface ImageRecord {
  fileName: string; publicId: string; url: string; width: number; height: number; bytes: number; uploadedAt: Date;
}
const toRecord = (r: Row): ImageRecord => ({
  fileName: r.fileName, publicId: r.publicId, url: r.url, width: r.width, height: r.height, bytes: r.bytes, uploadedAt: r.updatedAt,
});

async function find(examId: string, fileName: string): Promise<ImageRecord | null> {
  const row = await ImageModel.findOne({ examId, fileName }).lean<Row>();
  return row ? toRecord(row) : null;
}

async function listForExam(examId: string): Promise<ImageRecord[]> {
  const rows = await ImageModel.find({ examId }).sort({ fileName: 1 }).lean<Row[]>();
  return rows.map(toRecord);
}

const count = (examId: string): Promise<number> => ImageModel.countDocuments({ examId });

/** Saves a picture under its file name. Uploading the same name again replaces it. */
async function save(
  input: { examId: string; fileName: string; publicId: string; url: string; width: number; height: number; bytes: number; uploadedBy: string },
  session: ClientSession,
): Promise<ImageRecord> {
  const { examId, fileName, ...rest } = input;
  const row = await ImageModel.findOneAndUpdate({ examId, fileName }, { $set: rest }, { upsert: true, new: true, session }).lean<Row>();
  if (!row) throw new Error('Image was not saved');
  return toRecord(row);
}

async function remove(examId: string, fileName: string, session: ClientSession): Promise<void> {
  await ImageModel.deleteOne({ examId, fileName }, { session });
}

/** Every stored picture of an exam, so its Cloudinary copies can be removed when the exam is deleted. */
async function takeAllForExam(examId: string): Promise<ImageRecord[]> {
  const rows = await ImageModel.find({ examId }).lean<Row[]>();
  await ImageModel.deleteMany({ examId });
  return rows.map(toRecord);
}

export const questionImageRepository = { find, listForExam, count, save, remove, takeAllForExam };
