import type { AuditService } from '../audit/audit.service';
import type { AuthModule } from '../auth/auth.module';
import { staffRepository } from '../users/staff.repository';
import { userRepository } from '../users/user.repository';
import { bookRepository } from './book.repository';
import { createLibraryRouter } from './library.routes';
import { createLibraryService } from './library.service';

/** The physical library: printed books lent at the desk. The digital library will be its own module. */
export function createLibraryModule(deps: { audit: AuditService; auth: AuthModule }) {
  const service = createLibraryService({ books: bookRepository, users: userRepository, staff: staffRepository, audit: deps.audit });
  return { router: createLibraryRouter({ service, authenticate: deps.auth.middleware.authenticate }), service };
}
