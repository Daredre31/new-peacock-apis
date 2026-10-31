import mongoose, { type ClientSession, type Model } from 'mongoose';

interface CounterDocument {
  _id: string;
  seq: number;
}

const schema = new mongoose.Schema<CounterDocument>(
  { _id: { type: String, required: true }, seq: { type: Number, required: true, default: 0 } },
  { versionKey: false },
);

export const CounterModel: Model<CounterDocument> =
  (mongoose.models.Counter as Model<CounterDocument> | undefined) ??
  mongoose.model<CounterDocument>('Counter', schema);

/** Atomic next number for a named sequence. Inside a transaction, an aborted create leaves no gap. */
export async function nextSequence(name: string, session?: ClientSession): Promise<number> {
  const doc = await CounterModel.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, ...(session ? { session } : {}) },
  ).lean<CounterDocument>();
  if (!doc) throw new Error('Could not allocate a number');
  return doc.seq;
}