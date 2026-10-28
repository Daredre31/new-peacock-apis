import { z } from 'zod';

export type IdentifierKind = 'email' | 'phone' | 'id';

export interface ParsedIdentifier {
  kind: IdentifierKind;
  value: string;
}

const MAX_LENGTH = 254;
const EMAIL = z.email();

// Nigerian mobile numbers: +234 followed by 7, 8 or 9 and nine more digits.
const NIGERIAN_MOBILE = /^\+234[789]\d{9}$/;
// Any other international number, E.164 style.
const INTERNATIONAL = /^\+[1-9]\d{7,14}$/;
// Staff IDs and registration numbers, after uppercasing: STF-0007, 2026/0007.
const ID_PATTERN = /^[A-Z0-9][A-Z0-9/_-]{2,39}$/;
// Only digits, spaces, dashes, dots, brackets and a leading +: this looks like a phone number.
const PHONE_SHAPE = /^\+?[\d\s\-().]+$/;

export function normalizeEmail(input: string): string | null {
  const value = input.trim().toLowerCase();
  if (value.length === 0 || value.length > MAX_LENGTH) return null;
  return EMAIL.safeParse(value).success ? value : null;
}

/** Returns the number in international format (+2348012345678), or null if it is not a valid phone number. */
export function normalizePhone(input: string): string | null {
  let value = input.trim().replace(/[\s\-().]/g, '');
  if (!/^\+?\d+$/.test(value)) return null;

  if (value.startsWith('00')) value = `+${value.slice(2)}`;
  else if (value.startsWith('+')) value = value;
  else if (value.startsWith('234') && value.length === 13) value = `+${value}`;
  else if (value.startsWith('0') && value.length === 11) value = `+234${value.slice(1)}`;
  else if (value.length === 10 && /^[789]/.test(value)) value = `+234${value}`;
  else return null;

  if (value.startsWith('+234')) return NIGERIAN_MOBILE.test(value) ? value : null;
  return INTERNATIONAL.test(value) ? value : null;
}

/**
 * Works out what the person typed into the single login box.
 * Returns null for anything unusable. The login service treats null exactly like
 * a wrong password, so nobody can learn anything from the rejection.
 *
 * Rule for later: staff numbers and registration numbers must contain a letter or "/"
 * (STF-0007, 2026/0007). A value made only of digits and separators is always a phone number.
 */
export function parseIdentifier(input: unknown): ParsedIdentifier | null {
  if (typeof input !== 'string') return null;

  const raw = input.trim();
  if (raw.length === 0 || raw.length > MAX_LENGTH) return null;

  if (raw.includes('@')) {
    const email = normalizeEmail(raw);
    return email ? { kind: 'email', value: email } : null;
  }

  if (PHONE_SHAPE.test(raw)) {
    const phone = normalizePhone(raw);
    return phone ? { kind: 'phone', value: phone } : null;
  }

  const id = raw.toUpperCase();
  return ID_PATTERN.test(id) ? { kind: 'id', value: id } : null;
}