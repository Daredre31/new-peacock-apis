import { AppError } from '../errors/AppError';
import { logger } from '../utils/logger';
import { ROLES } from '../../config/constants';
import type { ScopePorts } from './ports';

const OBJECT_ID = /^[a-f0-9]{24}$/;

type Actor = Pick<Express.AuthUser, 'id' | 'role'>;

export function createScopeService(ports: ScopePorts) {
  // Out of scope is always NOT_FOUND, never FORBIDDEN, so ids can't be probed.
  function deny(actor: Actor, resource: string, id: string): never {
    logger.warn({ userId: actor.id, role: actor.role, resource, id }, 'scope denied');
    throw new AppError('NOT_FOUND');
  }

  async function studentInScope(actor: Actor, studentId: string): Promise<boolean> {
    if (!OBJECT_ID.test(studentId)) return false;
    switch (actor.role) {
      case ROLES.SUPER_ADMIN:
      case ROLES.ADMIN:
        return true;
      case ROLES.TEACHER:
        return ports.teacherTeachesStudent(actor.id, studentId);
      case ROLES.PARENT:
        return ports.parentHasActiveLink(actor.id, studentId);
      case ROLES.STUDENT:
        return (await ports.studentIdOfUser(actor.id)) === studentId;
      default:
        return false;
    }
  }

  async function classArmInScope(actor: Actor, classArmId: string): Promise<boolean> {
    if (!OBJECT_ID.test(classArmId)) return false;
    switch (actor.role) {
      case ROLES.SUPER_ADMIN:
      case ROLES.ADMIN:
        return true;
      case ROLES.TEACHER:
        return ports.teacherTeachesClassArm(actor.id, classArmId);
      default:
        return false; // parents and students reach classes only through their own children or themselves
    }
  }

  return {
    /** Parent: linked children only. Teacher: students they teach. Student: self. Admins: all. */
    async assertCanAccessStudent(actor: Actor, studentId: string): Promise<void> {
      if (!(await studentInScope(actor, studentId))) deny(actor, 'student', studentId);
    },

    async assertCanAccessClassArm(actor: Actor, classArmId: string): Promise<void> {
      if (!(await classArmInScope(actor, classArmId))) deny(actor, 'classArm', classArmId);
    },

    /** Daily attendance: the class teacher of that arm, or an admin. */
    async assertCanMarkAttendance(actor: Actor, classArmId: string): Promise<void> {
      const allowed =
        OBJECT_ID.test(classArmId) &&
        (actor.role === ROLES.ADMIN ||
          (actor.role === ROLES.TEACHER && (await ports.isClassTeacher(actor.id, classArmId))));
      if (!allowed) deny(actor, 'classArm', classArmId);
    },

    /** "Own profile" rules: a teacher, parent or student reaches only their own user record. Admins reach any. */
    assertOwnUserOrAdmin(actor: Actor, ownerUserId: string): void {
      const allowed =
        actor.role === ROLES.SUPER_ADMIN || actor.role === ROLES.ADMIN || actor.id === ownerUserId;
      if (!allowed) deny(actor, 'user', ownerUserId);
    },
  };
}

export type ScopeService = ReturnType<typeof createScopeService>;