import { addDays, daysBetween, isIsoDate, schoolToday, workingDaysBetween } from '../../common/utils/dates';

const MAX_LEAVE_DAYS = 180;
const MAX_BACKDATE_DAYS = 7;

/** True if the value is a timestamp (optionally only counting the future). Used for "cannot be in the future" checks. */
export function isoDateOrNull(value: unknown, future: boolean): boolean {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return !Number.isNaN(time) && future && time > Date.now() + 5 * 60 * 1000;
}

/** Checks a leave date range and counts its working days (Monday to Friday). */
export function schoolDateWindow(
  start: string,
  end: string,
): { workingDays: number | null; error?: { field: string; issue: string } } {
  if (!isIsoDate(start)) return { workingDays: null, error: { field: 'startDate', issue: 'Invalid date' } };
  if (!isIsoDate(end)) return { workingDays: null, error: { field: 'endDate', issue: 'Invalid date' } };
  if (end < start) return { workingDays: null, error: { field: 'endDate', issue: 'Must not be before the start date' } };
  if (start < addDays(schoolToday(), -MAX_BACKDATE_DAYS)) return { workingDays: null, error: { field: 'startDate', issue: `Cannot start more than ${MAX_BACKDATE_DAYS} days ago` } };
  if (daysBetween(start, end) + 1 > MAX_LEAVE_DAYS) return { workingDays: null, error: { field: 'endDate', issue: `Leave cannot be longer than ${MAX_LEAVE_DAYS} days` } };

  const workingDays = workingDaysBetween(start, end);
  if (workingDays < 1) return { workingDays: null, error: { field: 'startDate', issue: 'These dates contain no working days' } };
  return { workingDays };
}