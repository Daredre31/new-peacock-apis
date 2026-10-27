import { connectMongo, disconnectMongo, pingMongo } from '../src/config/db';
import { connectRedis, disconnectRedis, pingRedis } from '../src/config/redis';
import { logger } from '../src/common/utils/logger';

async function main(): Promise<void> {
  try {
    await connectMongo();
    logger.info(await pingMongo(), 'mongodb ping');

    await connectRedis();
    logger.info(await pingRedis(), 'redis ping');
  } catch (err) {
    logger.error({ err }, 'connection check failed');
    process.exitCode = 1;
  } finally {
    await disconnectMongo();
    await disconnectRedis();
  }
}

void main();