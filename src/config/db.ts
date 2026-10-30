import mongoose, { type ConnectOptions } from 'mongoose';
import type { DependencyHealth } from '../common/types/health';
import { logger } from '../common/utils/logger';
import { withTimeout } from '../common/utils/withTimeout';
import { env, isProduction } from './env';

const PING_TIMEOUT_MS = 2_000;
const CONNECTED = 1;

const DEFAULT_OPTIONS: ConnectOptions = {
  appName: 'peacock-academy-api',
  serverSelectionTimeoutMS: 10_000,
  connectTimeoutMS: 10_000,
  socketTimeoutMS: 45_000,
  maxPoolSize: 20,
  minPoolSize: 2,
  // Queries made while disconnected fail at once instead of silently waiting.
  bufferCommands: false,
};

let listenersRegistered = false;

function registerListeners(): void {
  if (listenersRegistered) return;
  listenersRegistered = true;

  const { connection } = mongoose;
  connection.on('disconnected', () => logger.warn('mongodb disconnected'));
  connection.on('reconnected', () => logger.info('mongodb reconnected'));
  connection.on('error', (err: unknown) => logger.error({ err }, 'mongodb error'));
}

/** Transactions (payments, exam submission, result publishing) only work on a replica set. */
async function assertReplicaSet(): Promise<void> {
  const hello = await mongoose.connection.db?.admin().command({ hello: 1 });
  if (typeof hello?.setName === 'string') return;

  const message =
    'MongoDB is not running as a replica set, so transactions will fail. ' +
    'Atlas clusters are replica sets by default.';

  if (isProduction) throw new Error(message);
  logger.warn(message);
}

export async function connectMongo(
  uri: string = env.MONGODB_URI,
  overrides: ConnectOptions = {},
): Promise<void> {
  if (mongoose.connection.readyState === CONNECTED) return;

  registerListeners();
  mongoose.set('strictQuery', true);

  await mongoose.connect(uri, { ...DEFAULT_OPTIONS, ...overrides });

  try {
    await assertReplicaSet();
  } catch (err) {
    await mongoose.disconnect();
    throw err;
  }

  logger.info('mongodb connected');
}

export async function pingMongo(): Promise<DependencyHealth> {
  const started = performance.now();
  const elapsed = (): number => Math.round(performance.now() - started);

  const db = mongoose.connection.db;
  if (mongoose.connection.readyState !== CONNECTED || !db) {
    return { ok: false, latencyMs: 0 };
  }

  try {
    await withTimeout(db.admin().ping(), PING_TIMEOUT_MS, 'MongoDB ping');
    return { ok: true, latencyMs: elapsed() };
  } catch {
    return { ok: false, latencyMs: elapsed() };
  }
}

export async function disconnectMongo(): Promise<void> {
  if (mongoose.connection.readyState === 0) return;
  await mongoose.disconnect();
}
/** Makes sure every unique index exists before the app accepts traffic. */
export async function ensureIndexes(): Promise<void> {
  await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
}