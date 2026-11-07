/** NGN 100 million. Far below 2^53, so integer kobo are always exact. */
export const MAX_KOBO = 10_000_000_000;

/** A whole, positive number of kobo within bounds. Anything else is refused, never rounded. */
export const isKobo = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= MAX_KOBO;

/** Naira with two decimals, built from integer kobo with no floating point. */
export function formatNaira(kobo: number): string {
  const abs = Math.abs(kobo);
  const whole = Math.floor(abs / 100).toLocaleString('en-US');
  return `${kobo < 0 ? '-' : ''}${whole}.${String(abs % 100).padStart(2, '0')}`;
}