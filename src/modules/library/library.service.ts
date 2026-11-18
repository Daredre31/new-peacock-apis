import { AppError } from '../../common/errors/AppError';
import { ROLES } from '../../config/constants';
import { withTransaction } from '../../config/db';
import type { AuditPort } from '../audit/audit.port';
import type { staffRepository } from '../users/staff.repository';
import type { userRepository } from '../users/user.repository';
import type { bookRepository, BookInput, BookRecord, CopyCounts, CopyPatch, CopyRecord, ListBooksQuery } from './book.repository';

interface Actor { id: string; role: string; isLibrarian: boolean }
interface Context { ip: string; requestId: string }

export interface BookView extends Omit<BookRecord, 'priceKobo'> {
  copies: CopyCounts;
  /** Only librarians and admins see what a book is worth. */
  priceKobo?: number | null;
}
export interface BookDetail extends BookView { copyList?: CopyRecord[] }
export interface LibrarianView { userId: string; staffNo: string | null; name: string }

/** Admins and designated teachers. The same rule authorizeLibrarian applies to the routes. */
export const isLibraryManager = (user: { role: string; isLibrarian: boolean }): boolean =>
  user.role === ROLES.SUPER_ADMIN || user.role === ROLES.ADMIN || (user.role === ROLES.TEACHER && user.isLibrarian);

export function createLibraryService(deps: {
  books: typeof bookRepository;
  users: Pick<typeof userRepository, 'setLibrarian' | 'listLibrarians'>;
  staff: Pick<typeof staffRepository, 'findByUserId'>;
  audit: AuditPort;
}) {
  const { books, users, staff, audit } = deps;
  const invalid = (field: string, issue: string): AppError => new AppError('VALIDATION_ERROR', { details: [{ field, issue }] });
  const log = (action: string, actor: Actor, ctx: Context, entityType: string, entityId: string, metadata?: Record<string, unknown>): Promise<void> =>
    audit.record({ action, actorId: actor.id, entityType, entityId, ip: ctx.ip, requestId: ctx.requestId, ...(metadata ? { metadata } : {}) });

  const view = (book: BookRecord, copies: CopyCounts | undefined, manager: boolean): BookView => {
    const { priceKobo, ...rest } = book;
    return { ...rest, copies: copies ?? { total: 0, available: 0 }, ...(manager ? { priceKobo } : {}) };
  };

  return {
    async listBooks(query: ListBooksQuery, user: Actor): Promise<{ items: BookView[]; total: number }> {
      const { items, total } = await books.listBooks(query);
      const counts = await books.copyCounts(items.map((b) => b.id));
      const manager = isLibraryManager(user);
      return { items: items.map((b) => view(b, counts.get(b.id), manager)), total };
    },

    async getBook(id: string, user: Actor): Promise<BookDetail> {
      const book = await books.findBook(id);
      if (!book) throw new AppError('NOT_FOUND');
      const manager = isLibraryManager(user);
      const counts = await books.copyCounts([id]);
      const detail: BookDetail = view(book, counts.get(id), manager);
      if (manager) detail.copyList = await books.copiesOf(id);
      return detail;
    },

    listCategories: (): Promise<string[]> => books.listCategories(),

    /** The book and its first copies are saved together, so a failure never leaves a book with no copies it was meant to have. */
    async createBook(input: BookInput & { copies: number; shelfLocation?: string | null | undefined }, actor: Actor, ctx: Context): Promise<BookDetail> {
      const { copies, shelfLocation, ...fields } = input;
      const created = await withTransaction(async (tx) => {
        const book = await books.createBook(fields, tx);
        const made = copies > 0 ? await books.createCopies(book.id, copies, shelfLocation ?? null, tx) : [];
        return { book, made };
      });
      await log('PHYSICAL_BOOK_CREATED', actor, ctx, 'PhysicalBook', created.book.id, { title: created.book.title, copies: created.made.length });
      return { ...view(created.book, { total: created.made.length, available: created.made.length }, true), copyList: created.made };
    },

    async updateBook(id: string, patch: Partial<BookInput>, actor: Actor, ctx: Context): Promise<BookDetail> {
      if (Object.values(patch).every((v) => v === undefined)) throw invalid('body', 'Nothing to update');
      const updated = await books.updateBook(id, patch);
      if (!updated) throw new AppError('NOT_FOUND');
      await log('PHYSICAL_BOOK_UPDATED', actor, ctx, 'PhysicalBook', id, { fields: Object.keys(patch).filter((k) => patch[k as keyof BookInput] !== undefined) });
      return this.getBook(id, actor);
    },

    async deleteBook(id: string, actor: Actor, ctx: Context): Promise<void> {
      const result = await withTransaction((tx) => books.softDeleteBook(id, tx));
      if (result === 'NOT_FOUND') throw new AppError('NOT_FOUND');
      if (result === 'ON_LOAN') throw new AppError('CONFLICT', { details: [{ field: 'id', issue: 'A copy of this book is out on loan. Wait for it to come back' }] });
      await log('PHYSICAL_BOOK_DELETED', actor, ctx, 'PhysicalBook', id);
    },

    async addCopies(bookId: string, input: { count: number; shelfLocation?: string | null | undefined }, actor: Actor, ctx: Context): Promise<CopyRecord[]> {
      if (!(await books.findBook(bookId))) throw new AppError('NOT_FOUND');
      const made = await withTransaction((tx) => books.createCopies(bookId, input.count, input.shelfLocation ?? null, tx));
      await log('PHYSICAL_COPIES_ADDED', actor, ctx, 'PhysicalBook', bookId, { barcodes: made.map((c) => c.barcode) });
      return made;
    },

    async updateCopy(id: string, patch: CopyPatch, actor: Actor, ctx: Context): Promise<CopyRecord> {
      if (Object.values(patch).every((v) => v === undefined)) throw invalid('body', 'Nothing to update');
      const result = await books.updateCopy(id, patch);
      if (result === null) throw new AppError('NOT_FOUND');
      if (result === 'ON_LOAN') throw new AppError('CONFLICT', { details: [{ field: 'status', issue: 'This copy is out on loan. Return it first' }] });
      await log('PHYSICAL_COPY_UPDATED', actor, ctx, 'PhysicalCopy', id, { barcode: result.barcode, ...(patch.status ? { status: patch.status } : {}) });
      return result;
    },

    async listLibrarians(): Promise<LibrarianView[]> {
      const records = await users.listLibrarians();
      const rows = await Promise.all(records.map(async (u): Promise<LibrarianView> => {
        const profile = await staff.findByUserId(u.id);
        return { userId: u.id, staffNo: profile?.staffNo ?? null, name: profile ? `${profile.firstName} ${profile.lastName}` : '' };
      }));
      return rows.sort((a, b) => a.name.localeCompare(b.name));
    },

    /** Only an active teacher can be made a librarian. Admins already have the access. */
    async setLibrarian(userId: string, isLibrarian: boolean, actor: Actor, ctx: Context): Promise<{ userId: string; isLibrarian: boolean }> {
      if (!(await users.setLibrarian(userId, isLibrarian))) throw invalid('userId', 'Only an active teacher can be made a librarian');
      await log(isLibrarian ? 'LIBRARIAN_DESIGNATED' : 'LIBRARIAN_REMOVED', actor, ctx, 'User', userId);
      return { userId, isLibrarian };
    },
  };
}

export type LibraryService = ReturnType<typeof createLibraryService>;
