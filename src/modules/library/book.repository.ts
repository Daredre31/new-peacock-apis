import mongoose, { type ClientSession, type Model, type Types } from 'mongoose';
import { AppError } from '../../common/errors/AppError';
import { skipOf } from '../../common/utils/pagination';
import { escapeRegex } from '../../common/utils/search';
import { nextSequence } from '../users/counter.model';

export const COPY_STATUS = { AVAILABLE: 'AVAILABLE', ON_LOAN: 'ON_LOAN', LOST: 'LOST', DAMAGED: 'DAMAGED', WITHDRAWN: 'WITHDRAWN' } as const;
export type CopyStatus = (typeof COPY_STATUS)[keyof typeof COPY_STATUS];

interface BookDocument {
  title: string;
  authors: string[];
  /** Left out entirely when there is none, so the unique index only covers books that have one. */
  isbn?: string;
  category: string;
  publisher: string | null;
  publishedYear: number | null;
  description: string | null;
  priceKobo: number | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
type BookRow = BookDocument & { _id: Types.ObjectId };

interface CopyDocument {
  bookId: Types.ObjectId;
  barcode: string;
  status: CopyStatus;
  shelfLocation: string | null;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}
type CopyRow = CopyDocument & { _id: Types.ObjectId };

const bookSchema = new mongoose.Schema<BookDocument>(
  {
    title: { type: String, required: true, maxlength: 200 },
    authors: { type: [String], required: true },
    isbn: { type: String },
    category: { type: String, required: true, maxlength: 60 },
    publisher: { type: String, default: null, maxlength: 100 },
    publishedYear: { type: Number, default: null },
    description: { type: String, default: null, maxlength: 2000 },
    priceKobo: { type: Number, default: null, min: 0 },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);
bookSchema.index({ isbn: 1 }, { unique: true, partialFilterExpression: { isbn: { $type: 'string' } } });
bookSchema.index({ deletedAt: 1, title: 1 });
bookSchema.index({ deletedAt: 1, category: 1 });

const copySchema = new mongoose.Schema<CopyDocument>(
  {
    bookId: { type: mongoose.Schema.Types.ObjectId, ref: 'LibraryBook', required: true },
    barcode: { type: String, required: true },
    status: { type: String, enum: Object.values(COPY_STATUS), default: COPY_STATUS.AVAILABLE },
    shelfLocation: { type: String, default: null, maxlength: 50 },
    note: { type: String, default: null, maxlength: 200 },
  },
  { timestamps: true, versionKey: false },
);
copySchema.index({ barcode: 1 }, { unique: true });
copySchema.index({ bookId: 1, status: 1 });

export const BookModel: Model<BookDocument> =
  (mongoose.models.LibraryBook as Model<BookDocument> | undefined) ?? mongoose.model<BookDocument>('LibraryBook', bookSchema);
export const CopyModel: Model<CopyDocument> =
  (mongoose.models.LibraryCopy as Model<CopyDocument> | undefined) ?? mongoose.model<CopyDocument>('LibraryCopy', copySchema);

export interface BookRecord {
  id: string; title: string; authors: string[]; isbn: string | null; category: string; publisher: string | null;
  publishedYear: number | null; description: string | null; priceKobo: number | null;
}
export interface CopyRecord { id: string; bookId: string; barcode: string; status: CopyStatus; shelfLocation: string | null; note: string | null }
export interface CopyCounts { total: number; available: number }

export interface BookInput {
  title: string; authors: string[]; isbn?: string | null | undefined; category: string; publisher?: string | null | undefined;
  publishedYear?: number | null | undefined; description?: string | null | undefined; priceKobo?: number | null | undefined;
}

const OBJECT_ID = /^[a-f0-9]{24}$/;
const toBook = (r: BookRow): BookRecord => ({
  id: r._id.toString(), title: r.title, authors: r.authors, isbn: r.isbn ?? null, category: r.category, publisher: r.publisher,
  publishedYear: r.publishedYear, description: r.description, priceKobo: r.priceKobo,
});
const toCopy = (r: CopyRow): CopyRecord => ({
  id: r._id.toString(), bookId: r.bookId.toString(), barcode: r.barcode, status: r.status, shelfLocation: r.shelfLocation, note: r.note,
});

/** A repeated ISBN is a CONFLICT that says which field clashed. */
function mapDuplicate(err: unknown): unknown {
  if (typeof err === 'object' && err !== null && 'code' in err && err.code === 11000) {
    return new AppError('CONFLICT', { details: [{ field: 'isbn', issue: 'A book with this ISBN already exists' }] });
  }
  return err;
}

async function createBook(input: BookInput, session: ClientSession): Promise<BookRecord> {
  try {
    const [doc] = await BookModel.create(
      [{
        title: input.title, authors: input.authors, category: input.category,
        ...(input.isbn ? { isbn: input.isbn } : {}),
        publisher: input.publisher ?? null, publishedYear: input.publishedYear ?? null,
        description: input.description ?? null, priceKobo: input.priceKobo ?? null,
      }],
      { session },
    );
    if (!doc) throw new Error('Book was not saved');
    return toBook(doc.toObject() as BookRow);
  } catch (err) {
    throw mapDuplicate(err);
  }
}

async function findBook(id: string): Promise<BookRecord | null> {
  if (!OBJECT_ID.test(id)) return null;
  const row = await BookModel.findOne({ _id: id, deletedAt: null }).lean<BookRow>();
  return row ? toBook(row) : null;
}

async function updateBook(id: string, patch: Partial<BookInput>): Promise<BookRecord | null> {
  if (!OBJECT_ID.test(id)) return null;
  const $set: Record<string, unknown> = {};
  const $unset: Record<string, ''> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key === 'isbn') { if (value === null || value === '') $unset.isbn = ''; else $set.isbn = value; continue; }
    $set[key] = value;
  }
  try {
    const row = await BookModel.findOneAndUpdate(
      { _id: id, deletedAt: null },
      { ...(Object.keys($set).length > 0 ? { $set } : {}), ...(Object.keys($unset).length > 0 ? { $unset } : {}) },
      { new: true },
    ).lean<BookRow>();
    return row ? toBook(row) : null;
  } catch (err) {
    throw mapDuplicate(err);
  }
}

/**
 * Takes a book off the shelf. Refused while any copy is out on loan. The ISBN is released so the same
 * book can be added again, and every copy is withdrawn so none can be lent.
 */
async function softDeleteBook(id: string, session: ClientSession): Promise<'DELETED' | 'NOT_FOUND' | 'ON_LOAN'> {
  if (!OBJECT_ID.test(id)) return 'NOT_FOUND';
  if (await CopyModel.exists({ bookId: id, status: COPY_STATUS.ON_LOAN }).session(session)) return 'ON_LOAN';
  const done = await BookModel.updateOne({ _id: id, deletedAt: null }, { $set: { deletedAt: new Date() }, $unset: { isbn: '' } }, { session });
  if (done.matchedCount === 0) return 'NOT_FOUND';
  await CopyModel.updateMany({ bookId: id }, { $set: { status: COPY_STATUS.WITHDRAWN } }, { session });
  return 'DELETED';
}

export interface ListBooksQuery { q?: string | undefined; category?: string | undefined; availableOnly?: boolean | undefined; page: number; limit: number }

async function listBooks(query: ListBooksQuery): Promise<{ items: BookRecord[]; total: number }> {
  const filter: Record<string, unknown> = { deletedAt: null };
  if (query.category) filter.category = new RegExp(`^${escapeRegex(query.category.trim())}$`, 'i');
  if (query.q) {
    const text = new RegExp(escapeRegex(query.q.trim()), 'i');
    filter.$or = [{ title: text }, { authors: text }, { isbn: text }];
  }
  if (query.availableOnly) {
    filter._id = { $in: await CopyModel.distinct('bookId', { status: COPY_STATUS.AVAILABLE }) };
  }
  const [rows, total] = await Promise.all([
    BookModel.find(filter).sort({ title: 1, _id: 1 }).skip(skipOf(query.page, query.limit)).limit(query.limit).lean<BookRow[]>(),
    BookModel.countDocuments(filter),
  ]);
  return { items: rows.map(toBook), total };
}

async function listCategories(): Promise<string[]> {
  const names = await BookModel.distinct('category', { deletedAt: null });
  return (names as string[]).sort((a, b) => a.localeCompare(b));
}

/** Withdrawn copies are not part of the holdings. Available means free to lend right now. */
async function copyCounts(bookIds: string[]): Promise<Map<string, CopyCounts>> {
  const ids = [...new Set(bookIds)].filter((id) => OBJECT_ID.test(id)).map((id) => new mongoose.Types.ObjectId(id));
  const result = new Map<string, CopyCounts>();
  if (ids.length === 0) return result;
  const rows = await CopyModel.aggregate<{ _id: { bookId: Types.ObjectId; status: CopyStatus }; n: number }>([
    { $match: { bookId: { $in: ids }, status: { $ne: COPY_STATUS.WITHDRAWN } } },
    { $group: { _id: { bookId: '$bookId', status: '$status' }, n: { $sum: 1 } } },
  ]);
  for (const r of rows) {
    const key = r._id.bookId.toString();
    const current = result.get(key) ?? { total: 0, available: 0 };
    current.total += r.n;
    if (r._id.status === COPY_STATUS.AVAILABLE) current.available += r.n;
    result.set(key, current);
  }
  return result;
}

async function copiesOf(bookId: string): Promise<CopyRecord[]> {
  if (!OBJECT_ID.test(bookId)) return [];
  const rows = await CopyModel.find({ bookId }).sort({ barcode: 1 }).lean<CopyRow[]>();
  return rows.map(toCopy);
}

/** Barcodes come from one counter, LIB-000001 onwards, so two librarians can never be given the same one. */
async function createCopies(bookId: string, count: number, shelfLocation: string | null, session: ClientSession): Promise<CopyRecord[]> {
  const docs: Pick<CopyDocument, 'bookId' | 'barcode' | 'status' | 'shelfLocation'>[] = [];
  for (let i = 0; i < count; i += 1) {
    const seq = await nextSequence('library-copy', session);
    docs.push({ bookId: new mongoose.Types.ObjectId(bookId), barcode: `LIB-${String(seq).padStart(6, '0')}`, status: COPY_STATUS.AVAILABLE, shelfLocation });
  }
  const saved = await CopyModel.insertMany(docs, { session });
  return saved.map((d) => toCopy(d.toObject() as CopyRow));
}

export interface CopyPatch { status?: 'AVAILABLE' | 'DAMAGED' | 'WITHDRAWN' | undefined; shelfLocation?: string | null | undefined; note?: string | null | undefined }

/** A copy that is out on loan cannot have its status changed here. The loan flow owns that. */
async function updateCopy(id: string, patch: CopyPatch): Promise<CopyRecord | 'ON_LOAN' | null> {
  if (!OBJECT_ID.test(id)) return null;
  const $set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) if (value !== undefined) $set[key] = value;
  const guard = patch.status !== undefined ? { status: { $ne: COPY_STATUS.ON_LOAN } } : {};
  const row = await CopyModel.findOneAndUpdate({ _id: id, ...guard }, { $set }, { new: true }).lean<CopyRow>();
  if (row) return toCopy(row);
  return (await CopyModel.exists({ _id: id })) ? 'ON_LOAN' : null;
}

export const bookRepository = {
  createBook, findBook, updateBook, softDeleteBook, listBooks, listCategories, copyCounts, copiesOf, createCopies, updateCopy,
};
