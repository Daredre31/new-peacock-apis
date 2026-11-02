const SCHOOL_UTC_OFFSET_MS = 60 * 60 * 1000; // Nigeria is UTC+1 all year
const DAY_MS = 86_400_000;

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Today's date at the school, as YYYY-MM-DD. */
export const schoolToday = (now: number = Date.now()): string => new Date(now + SCHOOL_UTC_OFFSET_MS).toISOString().slice(0, 10);

export const addDays = (iso: string, days: number): string =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

export const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

export const isWeekday = (iso: string): boolean => {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6;
};

/** Every date from `from` to `to`, inclusive. Throws if the range is backwards or longer than `max` days. */
export function eachDate(from: string, to: string, max: number): string[] {
  const span = daysBetween(from, to);
  if (span < 0 || span + 1 > max) throw new RangeError('Date range is invalid or too long');
  return Array.from({ length: span + 1 }, (_, i) => addDays(from, i));
}

export const workingDaysBetween = (from: string, to: string): number => eachDate(from, to, 400).filter(isWeekday).length;