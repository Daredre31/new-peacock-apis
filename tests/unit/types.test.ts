import type { Request } from 'express';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { ALL_ROLES, isRole, ROLES, type Role } from '../../src/config/constants';

describe('roles', () => {
  it('are exactly the five roles from the spec', () => {
    expect([...ALL_ROLES].sort()).toEqual(['ADMIN', 'PARENT', 'STUDENT', 'SUPER_ADMIN', 'TEACHER']);
  });

  it('isRole accepts roles and rejects everything else', () => {
    expect(isRole(ROLES.TEACHER)).toBe(true);
    expect(isRole('teacher')).toBe(false);
    expect(isRole('ROOT')).toBe(false);
    expect(isRole(undefined)).toBe(false);
  });
});

describe('express request typing', () => {
  it('exposes the merged fields with the right types', () => {
    expectTypeOf<Request['id']>().toEqualTypeOf<string>();
    expectTypeOf<Request['user']>().toEqualTypeOf<Express.AuthUser | undefined>();
    expectTypeOf<NonNullable<Request['user']>['role']>().toEqualTypeOf<Role>();
  });
});