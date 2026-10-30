import { denyAllScopePorts } from './ports';
import { createScopeService } from './scope.service';

/** Phase 2 replaces denyAllScopePorts with the real database-backed ports. */
export const scope = createScopeService(denyAllScopePorts);
export { assertCanChangeRole, assertCanManageRole, canManageRole } from './userManagement';