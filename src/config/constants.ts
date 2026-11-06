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

const { SUPER_ADMIN: SA, ADMIN: AD, TEACHER: TE, PARENT: PA, STUDENT: ST } = ROLES;

/**
 * Who may call each kind of endpoint. This is only the first of three checks
 * (authenticated, role allowed, record in scope). Notes marked "service" are
 * narrowed further by the scope rules in the service layer.
 */
export const PERMISSIONS = {
  // ---- session: every logged-in user (me, logout, logout-all, change-password)
  'session:self': ALL_ROLES,

  // ---- identity and people
  'admins:manage': [SA],
  'users:security': [SA, AD], // lock, unlock, reset password, force logout (service: AD never on admins)
  'users:login-history': [SA],
  'teachers:read': [SA, AD, TE], // service: teacher sees own profile only
  'teachers:write': [SA, AD],
  'students:read': [SA, AD, TE, PA, ST], // service: assigned classes / own children / self
  'students:write': [SA, AD],
  'students:import': [SA, AD],
  'parents:read': [SA, AD, PA], // service: parent sees own profile only
  'parents:write': [SA, AD],
  'parent-links:manage': [SA, AD],
  'parent-links:claim': [PA],
  'children:read': [PA],

  // ---- academics
  'sessions:read': ALL_ROLES,
  'sessions:write': [SA], // sessions, terms, set current, close
  'academics:read': ALL_ROLES, // classes, arms, subjects, timetable (service: scoped)
  'academics:write': [AD],
  'teaching-assignments:read': [SA, AD, TE], // service: teacher sees own
  'teaching-assignments:write': [AD],
  'teacher-classes:read': [TE],
  'events:read': ALL_ROLES,
  'events:write': [SA, AD],

  // ---- attendance
  'attendance:mark': [AD, TE], // service: teacher only for the class they teach as class teacher
  'attendance:read': [SA, AD, TE, PA, ST],
  'absence-notices:create': [PA],
  'absence-notices:read': [AD, TE],
  'staff-attendance:write': [AD],
  'staff-attendance:read': [SA, AD, TE],

  // ---- tasks (assignments)
  'tasks:read': [AD, TE, PA, ST],
  'tasks:write': [TE], // create, edit, grade
  'tasks:submit': [ST],

  // ---- scores, report cards, results
  'scores:enter': [TE], // grid, CSV import, submit for moderation
  'report-cards:compile': [TE],
  'report-cards:read': [SA, AD, PA, ST],
  'results:read': [SA, AD, TE, PA, ST], // published results (service: scoped)
  'results:moderate': [AD],
  'results:publish': [AD],
  'results:lock': [SA], // lock and unlock

  // ---- CBT
  'cbt:manage': [TE], // create, upload questions, release results
  'cbt:approve': [AD],
  'cbt:read': [SA, AD, TE, PA, ST], // service: scoped; parents see the schedule only
  'cbt:analytics': [SA, AD, TE],
  'cbt:take': [ST],

  // ---- fees and payments (students are deliberately absent from all of these)
  'fee-structures:read': [SA, AD],
  'fee-structures:write': [AD],
  'fee-structures:approve': [SA],
  'invoices:generate': [AD],
  'invoices:read': [SA, AD, PA],
  'payments:initialize': [PA],
  'payments:check': [PA], // status polling and "I paid but it is not showing"
  'payments:offline': [AD],
  'payments:read': [SA, AD, PA],
  'fees:defaulters': [SA, AD],
  'fees:reminders': [AD],
  'fees:analytics': [SA, AD, PA],

  // ---- request workflow (the type of request is checked in the service)
  'requests:create': [AD, TE, PA],
  'requests:read': [SA, AD, TE, PA],
  'requests:submit': [AD, TE, PA],
  'requests:return': [SA, AD],
  'requests:escalate': [AD],
  'requests:decide': [SA, AD], // service: admin only for short leave
  'requests:close': [SA, AD],
  'requests:comment': [SA, AD, TE, PA],

  // ---- communication
  'threads:use': [AD, TE, PA],
  'threads:create': [PA],
  'threads:status': [AD, TE],
  'announcements:read': ALL_ROLES,
  'announcements:create': [SA, AD, TE],
  'announcements:update': [SA, AD, TE], // service: author, admin or super admin
  'announcements:approve': [AD],
  'notifications:self': ALL_ROLES,

  // ---- dashboards, reports, settings, system
  'dashboard:super-admin': [SA],
  'dashboard:admin': [AD],
  'dashboard:teacher': [TE],
  'dashboard:parent': [PA],
  'dashboard:student': [ST],
  'analytics:revenue': [SA],
  'reports:generate': [SA, AD],
  'audit:read': [SA],
  'settings:read': [SA, AD],
  'settings:write': [SA],
  'grading-scale:read': [SA, AD, TE],
  'grading-scale:write': [SA],
  'uploads:presign': ALL_ROLES,
    'tasks:own': [ST], // a student's own task list and analytics
     'results:sheet': [SA, AD],
       'payments:reverse': [SA], // undo a recorded offline payment, with a reason
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

/** True only if the permission exists and lists this role. Anything unknown is denied. */
export function can(role: Role, permission: Permission): boolean {
  if (!Object.hasOwn(PERMISSIONS, permission)) return false;
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}
export const USER_STATUS = {
  ACTIVE: 'ACTIVE',
  /** Account exists but the person has not set a password yet (email-link invite). Cannot log in. */
  INVITED: 'INVITED',
  /** Locked on purpose by a super admin or admin. Stays locked until someone unlocks it. */
  LOCKED: 'LOCKED',
} as const;

export type UserStatus = (typeof USER_STATUS)[keyof typeof USER_STATUS];
export const AUTH_TTL = {
  accessSeconds: 15 * 60,
  refreshSeconds: 7 * 24 * 60 * 60,
  /** Hard cap on one login however often it is refreshed. Not in the spec: it stops a stolen cookie living forever. */
  maxSessionSeconds: 30 * 24 * 60 * 60,
  /** A just-used refresh token arriving again inside this window is a double click or a second tab, not theft. */
  reuseGraceMs: 10_000,
} as const;
export const AUTH_LOCKOUT = { maxAttempts: 10, lockMs: 15 * 60 * 1000 } as const;
/** More than this many working days counts as long leave, which the super admin decides. Open item in the spec: change it here. */
export const LEAVE_POLICY = { longLeaveAfterWorkingDays: 5 } as const;

/** Moves into the settings module later. */
export const ANNOUNCEMENT_POLICY = { teacherPostsNeedApproval: true } as const;
