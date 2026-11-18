import { z } from 'zod';
import { paginationShape } from '../../common/utils/pagination';
import { PERMISSIONS } from '../../config/constants';
import type { OpenApiRegistry } from '../../openapi/registry';

const objectId = z.string().regex(/^[a-f0-9]{24}$/);
const idParams = z.object({ id: objectId });
const userParams = z.object({ userId: objectId });

/** Strips hyphens and spaces, upper-cases, and checks the ISBN-10 or ISBN-13 check digit. Null when it is not a real ISBN. */
export function normalizeIsbn(raw: string): string | null {
  const text = raw.replace(/[\s-]/g, '').toUpperCase();
  if (/^\d{9}[\dX]$/.test(text)) {
    const sum = [...text].reduce((acc, ch, i) => acc + (ch === 'X' ? 10 : Number(ch)) * (10 - i), 0);
    return sum % 11 === 0 ? text : null;
  }
  if (/^\d{13}$/.test(text)) {
    const sum = [...text].reduce((acc, ch, i) => acc + Number(ch) * (i % 2 === 0 ? 1 : 3), 0);
    return sum % 10 === 0 ? text : null;
  }
  return null;
}

const isbn = z.string().trim().max(30).transform((value, ctx) => {
  const normal = normalizeIsbn(value);
  if (normal === null) { ctx.addIssue({ code: 'custom', message: 'Not a valid ISBN-10 or ISBN-13' }); return z.NEVER; }
  return normal;
});

const title = z.string().trim().min(1).max(200);
const authors = z.array(z.string().trim().min(1).max(100)).min(1).max(5);
const category = z.string().trim().min(1).max(60);
const shelf = z.string().trim().min(1).max(50);
const year = z.number().int().min(1400).max(2100);
const price = z.number().int().min(0).max(100_000_000);

export const bookIdSchemas = { params: idParams };
export const copyIdSchemas = { params: idParams };

export const listBooksSchemas = {
  query: z.object({
    ...paginationShape,
    q: z.string().trim().min(1).max(50).optional(),
    category: z.string().trim().min(1).max(60).optional(),
    availableOnly: z.stringbool().optional(),
  }),
};

const createBody = z.object({
  title, authors, category, isbn: isbn.optional(),
  publisher: z.string().trim().min(1).max(100).optional(), publishedYear: year.optional(),
  description: z.string().trim().min(1).max(2000).optional(), priceKobo: price.optional(),
  /** How many physical copies to add now. Each gets its own barcode. */
  copies: z.number().int().min(0).max(100).default(0),
  shelfLocation: shelf.optional(),
}).strict();
export const createBookSchemas = { body: createBody };

const updateBody = z.object({
  title: title.optional(), authors: authors.optional(), category: category.optional(), isbn: isbn.nullable().optional(),
  publisher: z.string().trim().min(1).max(100).nullable().optional(), publishedYear: year.nullable().optional(),
  description: z.string().trim().min(1).max(2000).nullable().optional(), priceKobo: price.nullable().optional(),
}).strict().refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export const updateBookSchemas = { params: idParams, body: updateBody };

const addCopiesBody = z.object({ count: z.number().int().min(1).max(100), shelfLocation: shelf.optional() }).strict();
export const addCopiesSchemas = { params: idParams, body: addCopiesBody };

const updateCopyBody = z.object({
  /** A copy on loan or lost changes status through the loan flow, not here. */
  status: z.enum(['AVAILABLE', 'DAMAGED', 'WITHDRAWN']).optional(),
  shelfLocation: shelf.nullable().optional(),
  note: z.string().trim().min(1).max(200).nullable().optional(),
}).strict().refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export const updateCopySchemas = { params: idParams, body: updateCopyBody };

const designateBody = z.object({ isLibrarian: z.boolean() }).strict();
export const designateSchemas = { params: userParams, body: designateBody };

export function registerLibraryOperations(registry: OpenApiRegistry): void {
  const tags = ['library-physical'];
  const sharedTags = ['library'];
  const num = z.number().int();
  const copies = z.object({ total: num, available: num });
  const copy = z.object({ id: z.string(), bookId: z.string(), barcode: z.string(), status: z.enum(['AVAILABLE', 'ON_LOAN', 'LOST', 'DAMAGED', 'WITHDRAWN']), shelfLocation: z.string().nullable(), note: z.string().nullable() });
  const book = z.object({
    id: z.string(), title: z.string(), authors: z.array(z.string()), isbn: z.string().nullable(), category: z.string(),
    publisher: z.string().nullable(), publishedYear: num.nullable(), description: z.string().nullable(), copies,
    priceKobo: num.nullable().optional().describe('Only librarians and admins see this'),
  });
  const detail = book.extend({ copyList: z.array(copy).optional().describe('Only librarians and admins see the individual copies') });
  const read = PERMISSIONS['physical-library:read'];
  const manage = PERMISSIONS['physical-library:manage'];
  const desk = ' A teacher needs to be designated a librarian first';

  registry.register({ method: 'get', path: '/library/physical/books', operationId: 'listPhysicalBooks', summary: 'Physical library: search the catalogue by title, author or ISBN. Shows how many copies are free to borrow', tags, roles: read, request: { query: listBooksSchemas.query }, success: { status: 200, description: 'Books', data: z.array(book), paginated: true } });
  registry.register({ method: 'get', path: '/library/physical/categories', operationId: 'listPhysicalCategories', summary: 'Every category in use, for a filter', tags, roles: read, success: { status: 200, description: 'Categories', data: z.array(z.string()) } });
  registry.register({ method: 'get', path: '/library/physical/books/{id}', operationId: 'getPhysicalBook', summary: 'One book. Librarians and admins also see its price and every copy with its barcode', tags, roles: read, request: { params: idParams }, success: { status: 200, description: 'The book', data: detail }, errors: ['NOT_FOUND'] });
  registry.register({ method: 'post', path: '/library/physical/books', operationId: 'createPhysicalBook', summary: `Add a book, optionally with its first copies. Barcodes are made automatically (LIB-000001...).${desk}`, tags, roles: manage, request: { body: createBody }, success: { status: 201, description: 'Created', data: detail }, errors: ['CONFLICT'] });
  registry.register({ method: 'patch', path: '/library/physical/books/{id}', operationId: 'updatePhysicalBook', summary: `Edit a book. Send null to clear an optional field.${desk}`, tags, roles: manage, request: { params: idParams, body: updateBody }, success: { status: 200, description: 'Updated', data: detail }, errors: ['NOT_FOUND', 'CONFLICT', 'VALIDATION_ERROR'] });
  registry.register({ method: 'delete', path: '/library/physical/books/{id}', operationId: 'deletePhysicalBook', summary: `Remove a book and withdraw all its copies. Refused while a copy is out on loan.${desk}`, tags, roles: manage, request: { params: idParams }, success: { status: 200, description: 'Removed', data: z.null() }, errors: ['NOT_FOUND', 'CONFLICT'] });
  registry.register({ method: 'post', path: '/library/physical/books/{id}/copies', operationId: 'addPhysicalCopies', summary: `Add more physical copies of a book, each with its own barcode.${desk}`, tags, roles: manage, request: { params: idParams, body: addCopiesBody }, success: { status: 201, description: 'The new copies', data: z.array(copy) }, errors: ['NOT_FOUND'] });
  registry.register({ method: 'patch', path: '/library/physical/copies/{id}', operationId: 'updatePhysicalCopy', summary: `Mark a copy AVAILABLE, DAMAGED or WITHDRAWN, or change its shelf and note. A copy out on loan cannot change status.${desk}`, tags, roles: manage, request: { params: idParams, body: updateCopyBody }, success: { status: 200, description: 'Updated', data: copy }, errors: ['NOT_FOUND', 'CONFLICT', 'VALIDATION_ERROR'] });
  registry.register({ method: 'get', path: '/library/librarians', operationId: 'listLibrarians', summary: 'Teachers who run the library', tags: sharedTags, roles: PERMISSIONS['library:designate'], success: { status: 200, description: 'Librarians', data: z.array(z.object({ userId: z.string(), staffNo: z.string().nullable(), name: z.string() })) } });
  registry.register({ method: 'put', path: '/library/librarians/{userId}', operationId: 'setLibrarian', summary: 'Make a teacher a librarian, or take it away. Takes effect on their next request. Admins already have library access', tags: sharedTags, roles: PERMISSIONS['library:designate'], request: { params: userParams, body: designateBody }, success: { status: 200, description: 'Saved', data: z.object({ userId: z.string(), isLibrarian: z.boolean() }) }, errors: ['VALIDATION_ERROR'] });
}
