import { FastifyPluginAsync } from 'fastify';
import type { SystemStatus } from '@mirrormarkets/shared';
import { getConfig } from '../config.js';

export const systemRoutes: FastifyPluginAsync = async (app) => {
  // GET /system/status
  app.get('/status', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const config = getConfig();

    const status: SystemStatus = {
      api: 'ok',
      database: 'ok',
      redis: 'ok',
      dynamicApi: 'ok',
      polymarketClob: 'ok',
      relayer: 'ok',
      workers: {
        copyTrading: 'running',
        autoClaim: 'running',
        healthCheck: 'running',
        positionSync: 'running',
      },
      lastCheckedAt: new Date().toISOString(),
    };

    // Check database
    try {
      await app.prisma.$queryRaw`SELECT 1`;
    } catch {
      status.database = 'down';
    }

    // Check Redis
    try {
      await app.redis.ping();
    } catch {
      status.redis = 'down';
    }

    // Check Dynamic API health
    try {
      if (config.DYNAMIC_API_KEY) {
        const res = await fetch('https://app.dynamicauth.com/api/v0/health', {
          headers: { 'Authorization': `Bearer ${config.DYNAMIC_API_KEY}` },
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) status.dynamicApi = 'degraded';
      } else {
        // No API key configured — running mock mode
        status.dynamicApi = 'degraded';
      }
    } catch {
      status.dynamicApi = 'down';
    }

    // Check worker statuses from Redis
    try {
      const copyWorkerPing = await app.redis.get('worker:copy-trading:last-ping');
      const autoClaimPing = await app.redis.get('worker:auto-claim:last-ping');
      const healthPing = await app.redis.get('worker:health-check:last-ping');
      const positionPing = await app.redis.get('worker:position-sync:last-ping');

      const staleThreshold = Date.now() - 120_000; // 2 minutes

      if (!copyWorkerPing || parseInt(copyWorkerPing) < staleThreshold) {
        status.workers.copyTrading = 'stopped';
      }
      if (!autoClaimPing || parseInt(autoClaimPing) < staleThreshold) {
        status.workers.autoClaim = 'stopped';
      }
      if (!healthPing || parseInt(healthPing) < staleThreshold) {
        status.workers.healthCheck = 'stopped';
      }
      if (!positionPing || parseInt(positionPing) < staleThreshold) {
        status.workers.positionSync = 'stopped';
      }
    } catch {
      // If Redis is down, workers status is unknown
    }

    // Check Polymarket CLOB
    try {
      const res = await fetch('https://clob.polymarket.com/time');
      if (!res.ok) status.polymarketClob = 'degraded';
    } catch {
      status.polymarketClob = 'down';
    }

    // Set overall API status
    if (status.database === 'down' || status.redis === 'down') {
      status.api = 'degraded';
    }
    if (status.dynamicApi === 'down') {
      status.api = 'degraded';
    }

    return reply.send(status);
  });
};
