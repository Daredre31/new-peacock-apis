import { randomBytes, randomInt } from 'node:crypto';
import { argon2id, hash, needsRehash, verify } from 'argon2';
import { AppError, isAppError } from '../../common/errors/AppError';
import { logger } from '../../common/utils/logger';

export interface PasswordServiceOptions {
  /** Memory per hash, in KiB. */
  memoryCost: number;
  timeCost: number;
  parallelism: number;
  /** Hashes running at the same moment. Each one holds memoryCost of RAM. */
  maxConcurrent: number;
  /** Hashes allowed to wait. Beyond this we refuse instead of piling up. */
  maxQueued: number;
}

// OWASP's minimum recommendation for argon2id: 19 MiB, 2 passes, 1 lane.
export const PRODUCTION_PASSWORD_OPTIONS: PasswordServiceOptions = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  maxConcurrent: 4,
  maxQueued: 100,
};

// Passwords above this are rejected without hashing, so nobody can make us hash a megabyte.
const MAX_VERIFY_LENGTH = 1024;

export interface PasswordCheck {
  valid: boolean;
  /** True when the password is right but the stored hash uses older, weaker settings. */
  needsRehash: boolean;
}

const INVALID: PasswordCheck = { valid: false, needsRehash: false };

// No I, O, l, 0 or 1, so a password read from a printed slip cannot be misread.
const TEMP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** Runs at most maxConcurrent tasks at once, queues up to maxQueued, refuses the rest. */
function createLimiter(maxConcurrent: number, maxQueued: number) {
  let active = 0;
  const waiting: (() => void)[] = [];

  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active < maxConcurrent) {
      active += 1;
    } else {
      if (waiting.length >= maxQueued) throw new AppError('SERVICE_UNAVAILABLE');
      // When a waiter is released it inherits the finished task's slot.
      await new Promise<void>((resolve) => waiting.push(resolve));
    }

    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

export function createPasswordService(options: PasswordServiceOptions = PRODUCTION_PASSWORD_OPTIONS) {
  const hashOptions = {
    type: argon2id,
    memoryCost: options.memoryCost,
    timeCost: options.timeCost,
    parallelism: options.parallelism,
  } as const;

  const run = createLimiter(options.maxConcurrent, options.maxQueued);

  // The same Unicode form is used everywhere, so a password typed on another
  // keyboard or phone still matches the one that was set.
  const normalize = (password: string): string => password.normalize('NFKC');

  // A real hash of a random value, made with the same settings as real ones.
  // Checking against it when the account does not exist costs the same time as a real check.
  let dummyHash: Promise<string> | undefined;
  const getDummyHash = (): Promise<string> => {
    dummyHash ??= run(() => hash(randomBytes(32).toString('hex'), hashOptions)).catch((err: unknown) => {
      dummyHash = undefined; // try again next time
      throw err;
    });
    return dummyHash;
  };

  return {
    async hashPassword(password: string): Promise<string> {
      return run(() => hash(normalize(password), hashOptions));
    },

    /**
     * Never throws because of bad input or a damaged stored hash: those are just "not valid".
     * Pass null when the account does not exist or has no password yet; the work is
     * still done, so the response time does not reveal which case it was.
     * The one error it can throw is SERVICE_UNAVAILABLE when too many checks are queued.
     */
    async verifyPassword(storedHash: string | null | undefined, password: unknown): Promise<PasswordCheck> {
      if (typeof password !== 'string' || password.length === 0 || password.length > MAX_VERIFY_LENGTH) {
        return INVALID;
      }

      const candidate = normalize(password);
      const hasRealHash = typeof storedHash === 'string' && storedHash.length > 0;

      try {
        const target = hasRealHash ? storedHash : await getDummyHash();
        const matches = await run(() => verify(target, candidate));

        // The dummy hash can never produce a successful login.
        if (!hasRealHash || !matches) return INVALID;
        return { valid: true, needsRehash: needsRehash(target, hashOptions) };
      } catch (err) {
        if (isAppError(err)) throw err;
        // Most likely a damaged hash in the database. Log it, deny the login, keep running.
        logger.error({ err }, 'password verification failed');
        return INVALID;
      }
    },

    /** For admin-created accounts: 12 random characters in three groups, for example "Kx7m-Qp3w-Rt9z". */
    generateTemporaryPassword(): string {
      const chars = Array.from({ length: 12 }, () => TEMP_ALPHABET[randomInt(TEMP_ALPHABET.length)] ?? 'x');
      return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12)].map((g) => g.join('')).join('-');
    },
  };
}

export type PasswordService = ReturnType<typeof createPasswordService>;

export const passwordService = createPasswordService();