import { Router } from 'express';
import { passwordService } from '../auth/password.service';
import type { AuthModule } from '../auth/auth.module';
import type { AuditService } from '../audit/audit.service';
import { createSecurityRouter } from './security.routes';
import { createSecurityService } from './security.service';
import { createStaffRouter } from './staff.routes';
import { ADMIN_STAFF_CONFIG } from './staff.schema';
import { createStaffService } from './staff.service';
import { staffRepository } from './staff.repository';
import { userRepository } from './user.repository';

export function createUsersModule(deps: { audit: AuditService; auth: AuthModule }) {
  const authenticate = deps.auth.middleware.authenticate;

  const staffService = createStaffService({
    users: userRepository,
    staff: staffRepository,
    passwords: passwordService,
    credentials: deps.auth.credentials,
    tokens: deps.auth.tokens,
    audit: deps.audit,
  });
  const securityService = createSecurityService({
    users: userRepository,
    passwords: passwordService,
    tokens: deps.auth.tokens,
    audit: deps.audit,
  });

  const router = Router();
  router.use(createStaffRouter(ADMIN_STAFF_CONFIG, { service: staffService, authenticate }));
  router.use(createSecurityRouter({ service: securityService, authenticate }));

  return { router, staffService };
}