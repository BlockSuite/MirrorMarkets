import { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import type { TradingAuthorityProvider } from '@mirrormarkets/shared';
import { WORKER_INTERVALS } from '@mirrormarkets/shared';
import { CopyEngine } from '../engine/copy-engine.js';

export class CopyTradingWorker {
  private engine: CopyEngine;
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private prisma: PrismaClient,
    private redis: Redis,
    private logger: Logger,
    tradingAuthority: TradingAuthorityProvider,
  ) {
    this.engine = new CopyEngine(prisma, logger, tradingAuthority);
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    const pollMs = parseInt(process.env.COPY_POLL_INTERVAL_MS ?? '') || WORKER_INTERVALS.COPY_POLL_MS;

    this.logger.info({ pollMs }, 'Copy trading worker started');

    this.interval = setInterval(() => this.poll(), pollMs);
    // Run immediately
    this.poll();
  }

  stop(): void {
    this.running = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.logger.info('Copy trading worker stopped');
  }

  private async poll(): Promise<void> {
    try {
      await this.redis.set('worker:copy-trading:last-ping', Date.now().toString());

      // Get all active leaders being followed by users with copy enabled
      const activeFollows = await this.prisma.follow.findMany({
        where: {
          status: 'ACTIVE',
          user: {
            copyProfile: {
              status: 'ENABLED',
            },
          },
        },
        select: {
          leader: {
            select: {
              id: true,
              address: true,
              lastSyncedAt: true,
            },
          },
        },
        distinct: ['leaderId'],
      });

      const leaders = activeFollows.map((f) => f.leader);

      for (const leader of leaders) {
        try {
          await this.pollLeaderTrades(leader);
        } catch (error) {
          this.logger.error({ leaderId: leader.id, err: error }, 'Failed to poll leader trades');
        }
      }
    } catch (error) {
      this.logger.error({ err: error }, 'Copy trading poll error');
    }
  }

  private async pollLeaderTrades(leader: { id: string; address: string; lastSyncedAt: Date | null }): Promise<void> {
    // Fetch recent trades from Polymarket data API
    const res = await fetch(
      `https://data-api.polymarket.com/trades?maker=${leader.address}&limit=20`,
    );

    if (!res.ok) {
      this.logger.warn({ address: leader.address, status: res.status }, 'Failed to fetch leader trades');
      return;
    }

    const trades = await res.json();
    if (!Array.isArray(trades) || trades.length === 0) return;

    const lastSync = leader.lastSyncedAt ? leader.lastSyncedAt.getTime() : 0;

    for (const trade of trades) {
      const tradeTime = new Date(trade.timestamp ?? trade.created_at).getTime();
      if (tradeTime <= lastSync) continue;

      // Check if we already processed this trade
      const existing = await this.prisma.leaderEvent.findFirst({
        where: {
          leaderId: leader.id,
          transactionHash: trade.transactionHash ?? trade.tx_hash,
        },
      });

      if (existing) continue;

      await this.engine.processLeaderEvent({
        leaderId: leader.id,
        conditionId: trade.conditionId ?? trade.condition_id,
        tokenId: trade.tokenId ?? trade.asset_id,
        marketSlug: trade.marketSlug ?? trade.market_slug,
        side: trade.side === 'BUY' || trade.side === 0 ? 'BUY' : 'SELL',
        size: parseFloat(trade.size ?? trade.amount ?? '0'),
        price: parseFloat(trade.price ?? '0'),
        transactionHash: trade.transactionHash ?? trade.tx_hash,
      });
    }

    // Update last synced timestamp
    await this.prisma.leader.update({
      where: { id: leader.id },
      data: { lastSyncedAt: new Date() },
    });
  }
}
