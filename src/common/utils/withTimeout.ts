/** Rejects if the promise does not settle within `ms`, so a stalled dependency can never hang a caller. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label = 'Operation'): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}