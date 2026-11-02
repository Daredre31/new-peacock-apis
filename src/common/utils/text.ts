const TAG = /<[^>]*>/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const MAX_DEPTH = 6;

/** Plain text only: no markup, no control characters. The frontend still escapes on output. */
export const sanitizeText = (value: string): string => value.normalize('NFC').replace(CONTROL, '').replace(TAG, '').trim();

export function sanitizeDeep(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return sanitizeText(value);
  if (depth >= MAX_DEPTH || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeDeep(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sanitizeDeep(child, depth + 1)]));
}