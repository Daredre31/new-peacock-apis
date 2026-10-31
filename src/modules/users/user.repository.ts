import type { Types ,ClientSession} from 'mongoose';
import { AppError } from '../../common/errors/AppError';
import { USER_STATUS, type Role, type UserStatus } from '../../config/constants';
import { UserModel, type UserDocument } from './user.model';

type Lean = UserDocument & { _id: Types.ObjectId };

/** What the rest of the app sees. No password hash, and no Mongoose document. */
export interface UserRecord {
  id: string;
  email: string | null;
  emailVerified: boolean;
  phone: string | null;
  phoneVerified: boolean;
  role: Role;
  status: UserStatus;
  mustChangePassword: boolean;
  failedLoginCount: number;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  passwordChangedAt: Date | null;
  createdAt: Date;
}

/** Only the login flow ever receives this. */
export interface UserAuthRecord extends UserRecord {
  passwordHash: string | null;
}

export interface CreateUserInput {
  email?: string;
  phone?: string;
  passwordHash?: string;
  role: Role;
  status?: UserStatus;
  mustChangePassword?: boolean;
  emailVerified?: boolean;
  phoneVerified?: boolean;
}

export type UserLookup = { email: string } | { phone: string } | { id: string };

export interface LockoutPolicy {
  maxAttempts: number;
  lockMs: number;
}

const OBJECT_ID = /^[a-f0-9]{24}$/i;

function toRecord(doc: Lean): UserRecord {
  return {
    id: doc._id.toString(),
    email: doc.email ?? null,
    emailVerified: Boolean(doc.emailVerifiedAt),
    phone: doc.phone ?? null,
    phoneVerified: Boolean(doc.phoneVerifiedAt),
    role: doc.role,
    status: doc.status,
    mustChangePassword: doc.mustChangePassword,
    failedLoginCount: doc.failedLoginCount,
    lockedUntil: doc.lockedUntil ?? null,
    lastLoginAt: doc.lastLoginAt ?? null,
    passwordChangedAt: doc.passwordChangedAt ?? null,
    createdAt: doc.createdAt,
  };
}

/** A unique-index violation becomes a CONFLICT that says which field clashed. */
function mapDuplicateKey(err: unknown): unknown {
  if (typeof err !== 'object' || err === null || !('code' in err) || err.code !== 11000) {
    return err;
  }

  const keys =
    'keyPattern' in err && typeof err.keyPattern === 'object' && err.keyPattern !== null
      ? Object.keys(err.keyPattern)
      : [];
  const field = keys.find((key) => key === 'email' || key === 'phone');

  return new AppError('CONFLICT', {
    message: 'This record already exists',
    details: field ? [{ field, issue: 'Already in use' }] : undefined,
    cause: err,
  });
}

async function create(
  input: CreateUserInput,
  now: Date = new Date(),
  session?: ClientSession,
): Promise<UserRecord> {
  try {
    const [doc] = await UserModel.create(
      [
        {
          ...(input.email !== undefined && { email: input.email }),
          ...(input.phone !== undefined && { phone: input.phone }),
          ...(input.passwordHash !== undefined && { passwordHash: input.passwordHash }),
          role: input.role,
          status: input.status ?? USER_STATUS.ACTIVE,
          mustChangePassword: input.mustChangePassword ?? false,
          emailVerifiedAt: input.emailVerified ? now : null,
          phoneVerifiedAt: input.phoneVerified ? now : null,
          passwordChangedAt: input.passwordHash !== undefined ? now : null,
        },
      ],
      session ? { session } : {},
    );
    if (!doc) throw new Error('User was not created');
    return toRecord(doc.toObject() as Lean);
  } catch (err) {
    throw mapDuplicateKey(err);
  }
}

async function findById(id: string): Promise<UserRecord | null> {
  if (!OBJECT_ID.test(id)) return null;
  const doc = await UserModel.findOne({ _id: id, deletedAt: null }).lean<Lean>();
  return doc ? toRecord(doc) : null;
}

/** For the login flow only: includes the password hash. */
async function findAuth(lookup: UserLookup): Promise<UserAuthRecord | null> {
  // Values must be plain strings. An object here would be a query operator.
  if (!Object.values(lookup).every((value) => typeof value === 'string')) return null;

  let filter: Record<string, unknown>;
  if ('id' in lookup) {
    if (!OBJECT_ID.test(lookup.id)) return null;
    filter = { _id: lookup.id };
  } else if ('email' in lookup) {
    filter = { email: lookup.email };
  } else {
    filter = { phone: lookup.phone };
  }

  const doc = await UserModel.findOne({ ...filter, deletedAt: null })
    .select('+passwordHash')
    .lean<Lean>();
  return doc ? { ...toRecord(doc), passwordHash: doc.passwordHash ?? null } : null;
}

/**
 * Counts one failed password and locks the account when the limit is reached.
 * The counter moves with an atomic $inc, so parallel guesses cannot slip past the limit.
 * An existing lock is never extended, so an attacker cannot keep someone locked out forever.
 */
async function recordFailedLogin(
  id: string,
  policy: LockoutPolicy,
  now: Date = new Date(),
): Promise<UserRecord | null> {
  if (!OBJECT_ID.test(id)) return null;
  const base = { _id: id, deletedAt: null };

  // A lock that has run out starts a fresh count.
  await UserModel.updateOne(
    { ...base, lockedUntil: { $ne: null, $lte: now } },
    { $set: { failedLoginCount: 0, lockedUntil: null } },
  );

  const updated = await UserModel.findOneAndUpdate(
    base,
    { $inc: { failedLoginCount: 1 } },
    { new: true },
  ).lean<Lean>();
  if (!updated) return null;

  const alreadyLocked = updated.lockedUntil != null && updated.lockedUntil > now;
  if (updated.failedLoginCount >= policy.maxAttempts && !alreadyLocked) {
    const lockedUntil = new Date(now.getTime() + policy.lockMs);
    await UserModel.updateOne(
      { ...base, $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }] },
      { $set: { lockedUntil } },
    );
    return toRecord({ ...updated, lockedUntil });
  }

  return toRecord(updated);
}

async function recordSuccessfulLogin(id: string, now: Date = new Date()): Promise<void> {
  if (!OBJECT_ID.test(id)) return;
  await UserModel.updateOne(
    { _id: id, deletedAt: null },
    { $set: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now } },
  );
}

/**
 * Sets a new password. Also clears the automatic lockout and activates an invited account.
 * A manual lock (status LOCKED) is left alone: only an unlock removes it.
 */
async function setPassword(
  id: string,
  passwordHash: string,
  options: { mustChangePassword: boolean },
  now: Date = new Date(),
): Promise<boolean> {
  if (!OBJECT_ID.test(id)) return false;

  const result = await UserModel.updateOne(
    { _id: id, deletedAt: null },
    {
      $set: {
        passwordHash,
        mustChangePassword: options.mustChangePassword,
        passwordChangedAt: now,
        failedLoginCount: 0,
        lockedUntil: null,
      },
    },
  );
  if (result.matchedCount === 0) return false;

  await UserModel.updateOne(
    { _id: id, status: USER_STATUS.INVITED },
    { $set: { status: USER_STATUS.ACTIVE } },
  );
  return true;
}

async function markEmailVerified(id: string, now: Date = new Date()): Promise<boolean> {
  if (!OBJECT_ID.test(id)) return false;
  const result = await UserModel.updateOne(
    { _id: id, deletedAt: null, email: { $type: 'string' } },
    { $set: { emailVerifiedAt: now } },
  );
  return result.matchedCount > 0;
}

async function countByRole(role: Role): Promise<number> {
  return UserModel.countDocuments({ role, deletedAt: null });
}

/** Silent upgrade of the hash after a login. Unlike setPassword, it leaves every other field alone. */
async function replacePasswordHash(id: string, passwordHash: string): Promise<void> {
  if (!OBJECT_ID.test(id)) return;
  await UserModel.updateOne({ _id: id, deletedAt: null }, { $set: { passwordHash } });
}

async function findManyByIds(ids: string[]): Promise<UserRecord[]> {
  const valid = [...new Set(ids)].filter((id) => OBJECT_ID.test(id));
  if (valid.length === 0) return [];
  const docs = await UserModel.find({ _id: { $in: valid }, deletedAt: null }).lean<Lean[]>();
  return docs.map(toRecord);
}

/** Changing an email or phone resets its "verified" mark. */
async function updateContact(
  id: string,
  patch: { email?: string; phone?: string },
  session?: ClientSession,
): Promise<UserRecord | null> {
  if (!OBJECT_ID.test(id)) return null;
  const set: Record<string, unknown> = {};
  if (patch.email !== undefined) Object.assign(set, { email: patch.email, emailVerifiedAt: null });
  if (patch.phone !== undefined) Object.assign(set, { phone: patch.phone, phoneVerifiedAt: null });

  try {
    const doc = await UserModel.findOneAndUpdate(
      { _id: id, deletedAt: null },
      { $set: set },
      { new: true, runValidators: true, ...(session ? { session } : {}) },
    ).lean<Lean>();
    return doc ? toRecord(doc) : null;
  } catch (err) {
    throw mapDuplicateKey(err);
  }
}

async function softDelete(id: string, now: Date, session: ClientSession): Promise<boolean> {
  if (!OBJECT_ID.test(id)) return false;
  const result = await UserModel.updateOne({ _id: id, deletedAt: null }, { $set: { deletedAt: now } }, { session });
  return result.matchedCount > 0;
}

/** A deliberate lock. Only active or invited accounts can be locked. */
async function setLocked(id: string): Promise<boolean> {
  if (!OBJECT_ID.test(id)) return false;
  const result = await UserModel.updateOne(
    { _id: id, deletedAt: null, status: { $in: [USER_STATUS.ACTIVE, USER_STATUS.INVITED] } },
    { $set: { status: USER_STATUS.LOCKED } },
  );
  return result.matchedCount > 0;
}

/** Clears an automatic lockout and a deliberate lock. restoreTo is ACTIVE, or INVITED if there is no password yet. */
async function unlock(id: string, restoreTo: UserStatus): Promise<boolean> {
  if (!OBJECT_ID.test(id)) return false;
  const cleared = await UserModel.updateOne(
    { _id: id, deletedAt: null },
    { $set: { failedLoginCount: 0, lockedUntil: null } },
  );
  if (cleared.matchedCount === 0) return false;
  await UserModel.updateOne({ _id: id, status: USER_STATUS.LOCKED }, { $set: { status: restoreTo } });
  return true;
}

export const userRepository = {
  create,
  findById,
  findAuth,
  recordFailedLogin,
  recordSuccessfulLogin,
  setPassword,
  markEmailVerified,
  countByRole,
  replacePasswordHash,findManyByIds, updateContact, softDelete, setLocked, unlock
};