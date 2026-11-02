/** True for a duplicate-key error, including one reported inside a bulk write. */
export function isDuplicateKeyError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  if ('code' in err && err.code === 11000) return true;
  return (
    'writeErrors' in err &&
    Array.isArray(err.writeErrors) &&
    err.writeErrors.some((e: unknown) => typeof e === 'object' && e !== null && 'code' in e && e.code === 11000)
  );
}