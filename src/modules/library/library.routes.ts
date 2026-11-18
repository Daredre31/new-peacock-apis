import { Router, type RequestHandler } from 'express';
import { authorize, authorizeLibrarian } from '../../common/middleware/authorize';
import { validate, type Validated } from '../../common/middleware/validate';
import { buildPageMeta, sendCreated, sendSuccess } from '../../common/utils/apiResponse';
import { contextOf, requireUser } from '../../common/utils/request';
import {
  addCopiesSchemas, bookIdSchemas, createBookSchemas, designateSchemas, listBooksSchemas, updateBookSchemas, updateCopySchemas,
} from './library.schema';
import type { LibraryService } from './library.service';

export function createLibraryRouter(deps: { service: LibraryService; authenticate: RequestHandler }): Router {
  const { service, authenticate: auth } = deps;
  const router = Router();

  // ---- the physical library catalogue, for everyone who can borrow
  router.get('/library/physical/books', auth, authorize('physical-library:read'), validate(listBooksSchemas), async (req, res) => {
    const { query } = req.validated as Validated<typeof listBooksSchemas>;
    const { items, total } = await service.listBooks(query, requireUser(req));
    sendSuccess(res, items, { meta: buildPageMeta({ page: query.page, limit: query.limit, total }) });
  });

  router.get('/library/physical/categories', auth, authorize('physical-library:read'), async (_req, res) => {
    sendSuccess(res, await service.listCategories());
  });

  router.get('/library/physical/books/:id', auth, authorize('physical-library:read'), validate(bookIdSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof bookIdSchemas>;
    sendSuccess(res, await service.getBook(params.id, requireUser(req)));
  });

  // ---- the library desk: admins and designated teachers
  router.post('/library/physical/books', auth, authorizeLibrarian('physical-library:manage'), validate(createBookSchemas), async (req, res) => {
    const { body } = req.validated as Validated<typeof createBookSchemas>;
    sendCreated(res, await service.createBook(body, requireUser(req), contextOf(req)));
  });

  router.patch('/library/physical/books/:id', auth, authorizeLibrarian('physical-library:manage'), validate(updateBookSchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof updateBookSchemas>;
    sendSuccess(res, await service.updateBook(params.id, body, requireUser(req), contextOf(req)));
  });

  router.delete('/library/physical/books/:id', auth, authorizeLibrarian('physical-library:manage'), validate(bookIdSchemas), async (req, res) => {
    const { params } = req.validated as Validated<typeof bookIdSchemas>;
    await service.deleteBook(params.id, requireUser(req), contextOf(req));
    sendSuccess(res, null);
  });

  router.post('/library/physical/books/:id/copies', auth, authorizeLibrarian('physical-library:manage'), validate(addCopiesSchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof addCopiesSchemas>;
    sendCreated(res, await service.addCopies(params.id, body, requireUser(req), contextOf(req)));
  });

  router.patch('/library/physical/copies/:id', auth, authorizeLibrarian('physical-library:manage'), validate(updateCopySchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof updateCopySchemas>;
    sendSuccess(res, await service.updateCopy(params.id, body, requireUser(req), contextOf(req)));
  });

  // ---- choosing the librarians: admins only
  router.get('/library/librarians', auth, authorize('library:designate'), async (_req, res) => {
    sendSuccess(res, await service.listLibrarians());
  });

  router.put('/library/librarians/:userId', auth, authorize('library:designate'), validate(designateSchemas), async (req, res) => {
    const { params, body } = req.validated as Validated<typeof designateSchemas>;
    sendSuccess(res, await service.setLibrarian(params.userId, body.isLibrarian, requireUser(req), contextOf(req)));
  });

  return router;
}
