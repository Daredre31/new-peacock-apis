/** The five fixed roles. Values are UPPER_SNAKE, as the API conventions require. */
export const ROLES = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  ADMIN: 'ADMIN',
  TEACHER: 'TEACHER',
  PARENT: 'PARENT',
  STUDENT: 'STUDENT',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

export const ALL_ROLES = Object.values(ROLES);

export const isRole = (value: unknown): value is Role =>
  typeof value === 'string' && (ALL_ROLES as readonly string[]).includes(value);