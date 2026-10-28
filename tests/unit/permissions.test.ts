import { describe, expect, it } from 'vitest';
import { ALL_ROLES, can, PERMISSIONS, ROLES, type Permission, type Role } from '../../src/config/constants';

const entries = Object.entries(PERMISSIONS) as [Permission, readonly Role[]][];
const rolesOf = (permission: Permission): readonly Role[] => PERMISSIONS[permission];

describe('permission matrix integrity', () => {
  it('gives every permission at least one valid role, with no duplicates', () => {
    for (const [name, roles] of entries) {
      expect(roles.length, name).toBeGreaterThan(0);
      expect(new Set(roles).size, name).toBe(roles.length);
      for (const role of roles) expect(ALL_ROLES, name).toContain(role);
    }
  });

  it('names permissions as resource:action', () => {
    for (const [name] of entries) expect(name).toMatch(/^[a-z-]+:[a-z-]+$/);
  });
});

describe('can()', () => {
  it('allows listed roles and denies the rest', () => {
    expect(can(ROLES.SUPER_ADMIN, 'admins:manage')).toBe(true);
    expect(can(ROLES.ADMIN, 'admins:manage')).toBe(false);
    expect(can(ROLES.PARENT, 'payments:initialize')).toBe(true);
    expect(can(ROLES.TEACHER, 'payments:initialize')).toBe(false);
  });

  it('denies anything it does not know about', () => {
    expect(can(ROLES.SUPER_ADMIN, 'nope:nothing' as Permission)).toBe(false);
    expect(can(ROLES.SUPER_ADMIN, '__proto__' as Permission)).toBe(false);
    expect(can(ROLES.SUPER_ADMIN, 'constructor' as Permission)).toBe(false);
    expect(can(ROLES.SUPER_ADMIN, 'toString' as Permission)).toBe(false);
  });
});

describe('rules from the spec', () => {
  it('students never get fee or payment permissions', () => {
    const feeRelated = entries.filter(([name]) =>
      /^(fee-structures|fees|invoices|payments):/.test(name),
    );
    expect(feeRelated.length).toBeGreaterThan(0);
    for (const [name, roles] of feeRelated) expect(roles, name).not.toContain(ROLES.STUDENT);
  });

  it('students and parents never get a write or manage permission', () => {
    for (const [name, roles] of entries.filter(([n]) => /:(write|manage)$/.test(n))) {
      expect(roles, name).not.toContain(ROLES.STUDENT);
      expect(roles, name).not.toContain(ROLES.PARENT);
    }
  });

  it('keeps proprietor-only powers away from the admin', () => {
    const proprietorOnly: Permission[] = [
      'admins:manage',
      'users:login-history',
      'sessions:write',
      'results:lock',
      'fee-structures:approve',
      'analytics:revenue',
      'audit:read',
      'settings:write',
      'grading-scale:write',
    ];
    for (const name of proprietorOnly) expect(rolesOf(name), name).toEqual([ROLES.SUPER_ADMIN]);
  });

  it('lets only the right role do the role-specific jobs', () => {
    expect(rolesOf('cbt:take')).toEqual([ROLES.STUDENT]);
    expect(rolesOf('payments:initialize')).toEqual([ROLES.PARENT]);
    expect(rolesOf('scores:enter')).toEqual([ROLES.TEACHER]);
    expect(rolesOf('results:publish')).toEqual([ROLES.ADMIN]);
    expect(rolesOf('invoices:generate')).toEqual([ROLES.ADMIN]);
    expect(rolesOf('payments:offline')).toEqual([ROLES.ADMIN]);
  });

  it('gives each role exactly its own dashboard', () => {
    expect(rolesOf('dashboard:super-admin')).toEqual([ROLES.SUPER_ADMIN]);
    expect(rolesOf('dashboard:admin')).toEqual([ROLES.ADMIN]);
    expect(rolesOf('dashboard:teacher')).toEqual([ROLES.TEACHER]);
    expect(rolesOf('dashboard:parent')).toEqual([ROLES.PARENT]);
    expect(rolesOf('dashboard:student')).toEqual([ROLES.STUDENT]);
  });

  it('keeps students out of the review chain', () => {
    for (const [name, roles] of entries.filter(([n]) => n.startsWith('requests:'))) {
      expect(roles, name).not.toContain(ROLES.STUDENT);
    }
  });

  it('lets every role use their own session', () => {
    for (const role of ALL_ROLES) expect(can(role, 'session:self')).toBe(true);
  });
});