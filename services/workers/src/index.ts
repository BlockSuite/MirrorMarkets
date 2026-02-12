import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import pino from 'pino';
import { CopyTradingWorker } from './workers/copy-trading.worker.js';
import { AutoClaimWorker } from './workers/auto-claim.worker.js';
import { HealthCheckWorker } from './workers/health-check.worker.js';
import { PositionSyncWorker } from './workers/position-sync.worker.js';
import { getTradingAuthorityProvider } from './adapters/trading-authority.factory.js';

const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'info' : 'debug' });

async function main() {
  const prisma = new PrismaClient();
  await prisma.$connect();
  logger.info('Workers: Connected to database');

  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
  });
  logger.info('Workers: Connected to Redis');

  // Phase 2A: Shared trading authority provider for all workers
  const tradingAuthority = getTradingAuthorityProvider(prisma);
  logger.info('Workers: Trading authority provider initialized');

  const copyWorker = new CopyTradingWorker(prisma, redis, logger, tradingAuthority);
  const autoClaimWorker = new AutoClaimWorker(prisma, redis, logger);
  const healthWorker = new HealthCheckWorker(prisma, redis, logger);
  const positionWorker = new PositionSyncWorker(prisma, redis, logger);

  copyWorker.start();
  autoClaimWorker.start();
  healthWorker.start();
  positionWorker.start();

  logger.info('All workers started');

  const shutdown = async () => {
    logger.info('Shutting down workers...');
    copyWorker.stop();
    autoClaimWorker.stop();
    healthWorker.stop();
    positionWorker.stop();
    await redis.quit();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Failed to start workers:', err);
  process.exit(1);
});
