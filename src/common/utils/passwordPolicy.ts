import { AppError, type ErrorDetail } from '../errors/AppError';

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

// A short list of the worst offenders. This is a first line of defence, not a breach database.
const BANNED_FRAGMENTS = [
  'password',
  'passw0rd',
  'qwerty',
  'asdfgh',
  'abcdef',
  '123456',
  '000000',
  '111111',
  'letmein',
  'welcome',
  'iloveyou',
  'admin',
  'peacock',
  'school',
  'nigeria',
  'naija',
  'ibadan',
  'lagos',
];

export interface PasswordContext {
  email?: string | null;
  phone?: string | null;
  /** Staff ID, registration number, anything else that identifies the person. */
  identifiers?: readonly (string | null | undefined)[];
}

// Length is counted in characters (code points), not bytes, so emoji and accents count once.
const lengthOf = (value: string): number => [...value].length;

function containsPersonalInfo(lower: string, context: PasswordContext): boolean {
  const localPart = context.email?.split('@')[0]?.toLowerCase();
  if (localPart && localPart.length >= 4 && lower.includes(localPart)) return true;

  const phoneDigits = context.phone?.replace(/\D/g, '');
  if (phoneDigits && phoneDigits.length >= 8) {
    const digits = lower.replace(/\D/g, '');
    if (digits.includes(phoneDigits.slice(-8))) return true;
  }

  return (context.identifiers ?? []).some((id) => {
    const value = id?.trim().toLowerCase();
    return Boolean(value && value.length >= 4 && lower.includes(value));
  });
}

/** Returns what is wrong, as messages that are safe to show. Empty means the password is acceptable. */
export function checkPasswordPolicy(password: string, context: PasswordContext = {}): string[] {
  const length = lengthOf(password);
  if (length < PASSWORD_MIN_LENGTH) {
    return [`Must be at least ${PASSWORD_MIN_LENGTH} characters`];
  }
  if (length > PASSWORD_MAX_LENGTH) {
    return [`Must be at most ${PASSWORD_MAX_LENGTH} characters`];
  }

  const issues: string[] = [];
  const lower = password.normalize('NFKC').toLowerCase();

  if (new Set(lower).size < 5) issues.push('Too repetitive');
  if (BANNED_FRAGMENTS.some((fragment) => lower.includes(fragment))) {
    issues.push('Too common or easy to guess');
  }
  if (containsPersonalInfo(lower, context)) {
    issues.push('Must not contain your email, phone number or ID');
  }

  return issues;
}

export function assertPasswordPolicy(
  password: string,
  context: PasswordContext = {},
  field = 'newPassword',
): void {
  const issues = checkPasswordPolicy(password, context);
  if (issues.length === 0) return;

  const details: ErrorDetail[] = issues.map((issue) => ({ field, issue }));
  throw new AppError('VALIDATION_ERROR', { details });
}