import { model, models, Schema, type Model } from 'mongoose';
import { normalizeEmail, normalizePhone } from '../../common/utils/identifier';
import { ALL_ROLES, USER_STATUS, type Role, type UserStatus } from '../../config/constants';

export interface UserDocument {
  email?: string;
  emailVerifiedAt?: Date | null;
  phone?: string;
  phoneVerifiedAt?: Date | null;
  passwordHash?: string;
  role: Role;
  status: UserStatus;
  mustChangePassword: boolean;
  failedLoginCount: number;
  lockedUntil?: Date | null;
  lastLoginAt?: Date | null;
  passwordChangedAt?: Date | null;
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const isStoredEmail = (value: string): boolean => normalizeEmail(value) === value;
const isStoredPhone = (value: string): boolean => normalizePhone(value) === value;

const userSchema = new Schema<UserDocument>(
  {
    email: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: 254,
      validate: { validator: isStoredEmail, message: 'Invalid email address' },
    },
    emailVerifiedAt: { type: Date, default: null },
    phone: {
      type: String,
      validate: { validator: isStoredPhone, message: 'Phone must be in international format' },
    },
    phoneVerifiedAt: { type: Date, default: null },
    // Never returned unless a query asks for it with select('+passwordHash').
    passwordHash: { type: String, select: false },
    role: { type: String, enum: ALL_ROLES, required: true },
    status: {
      type: String,
      enum: Object.values(USER_STATUS),
      default: USER_STATUS.ACTIVE,
      required: true,
    },
    mustChangePassword: { type: Boolean, default: false },
    failedLoginCount: { type: Number, default: 0, min: 0 },
    lockedUntil: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
    passwordChangedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

// Email and phone are optional (students often have neither), but unique when present.
// A partial index ignores users who have no value, so any number of them can coexist.
userSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: 'string' } } },
);
userSchema.index(
  { phone: 1 },
  { unique: true, partialFilterExpression: { phone: { $type: 'string' } } },
);
userSchema.index({ role: 1, status: 1 });

export const UserModel: Model<UserDocument> =
  (models.User as Model<UserDocument> | undefined) ?? model<UserDocument>('User', userSchema);