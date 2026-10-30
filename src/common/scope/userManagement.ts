import { AppError } from '../errors/AppError';
import { ROLES, type Role } from '../../config/constants';

// Nobody can create or manage a SUPER_ADMIN through the API: that account only exists via the script.
const MANAGEABLE: Record<Role, readonly Role[]> = {
  [ROLES.SUPER_ADMIN]: [ROLES.ADMIN, ROLES.TEACHER, ROLES.PARENT, ROLES.STUDENT],
  [ROLES.ADMIN]: [ROLES.TEACHER, ROLES.PARENT, ROLES.STUDENT],
  [ROLES.TEACHER]: [],
  [ROLES.PARENT]: [],
  [ROLES.STUDENT]: [],
};

export const canManageRole = (actorRole: Role, targetRole: Role): boolean =>
  MANAGEABLE[actorRole].includes(targetRole);

/** Create, edit, delete, lock, unlock, reset password or force logout on an account of this role. */
export function assertCanManageRole(actorRole: Role, targetRole: Role): void {
  if (!canManageRole(actorRole, targetRole)) throw new AppError('FORBIDDEN');
}

/** Only the super admin changes anyone's role, and never into or out of SUPER_ADMIN. */
export function assertCanChangeRole(actorRole: Role, fromRole: Role, toRole: Role): void {
  if (actorRole !== ROLES.SUPER_ADMIN || !canManageRole(actorRole, fromRole) || !canManageRole(actorRole, toRole)) {
    throw new AppError('FORBIDDEN');
  }
}