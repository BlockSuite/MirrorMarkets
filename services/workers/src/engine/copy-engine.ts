import { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { TradingAuthorityProvider } from '@mirrormarkets/shared';
import { AppError, ErrorCodes } from '@mirrormarkets/shared';
import { CircuitBreaker } from './circuit-breaker.js';
import { evaluateGuardrails } from './guardrails.js';
import { PolymarketAdapter } from '../adapters/polymarket.adapter.js';

/**
 * CopyEngine — Phase 2A
 *
 * Core copy-trading logic.  All signing is done through the
 * TradingAuthorityProvider — no raw private keys are used.
 *
 * If the Dynamic API is unavailable, the engine pauses (SIGNING_UNAVAILABLE)
 * and the circuit breaker opens.
 */
export class CopyEngine {
  private circuitBreaker = new CircuitBreaker();

  constructor(
    private prisma: PrismaClient,
    private logger: Logger,
    private tradingAuthority: TradingAuthorityProvider,
  ) {}

  async processLeaderEvent(event: {
    leaderId: string;
    conditionId: string;
    tokenId: string;
    marketSlug?: string;
    side: 'BUY' | 'SELL';
    size: number;
    price: number;
    transactionHash?: string;
  }): Promise<void> {
    // Store leader event
    const leaderEvent = await this.prisma.leaderEvent.create({
      data: {
        leaderId: event.leaderId,
        conditionId: event.conditionId,
        tokenId: event.tokenId,
        marketSlug: event.marketSlug,
        side: event.side,
        size: event.size,
        price: event.price,
        transactionHash: event.transactionHash,
      },
    });

    // Find all followers with copy enabled
    const follows = await this.prisma.follow.findMany({
      where: {
        leaderId: event.leaderId,
        status: 'ACTIVE',
        user: {
          copyProfile: {
            status: 'ENABLED',
          },
        },
      },
      include: {
        user: {
          include: {
            copyProfile: true,
            wallets: true,
            polymarketCredentials: true,
            serverWallet: true,
          },
        },
      },
    });

    this.logger.info({ leaderId: event.leaderId, followers: follows.length }, 'Processing leader event for followers');

    for (const follow of follows) {
      await this.processCopyForUser(follow.user, leaderEvent);
    }
  }

  private async processCopyForUser(user: any, leaderEvent: any): Promise<void> {
    // Check circuit breaker
    if (!this.circuitBreaker.canExecute()) {
      await this.prisma.copyAttempt.create({
        data: {
          userId: user.id,
          leaderEventId: leaderEvent.id,
          status: 'SKIPPED',
          skipReason: 'Circuit breaker open',
        },
      });
      return;
    }

    // Check for duplicate copy
    const existingAttempt = await this.prisma.copyAttempt.findFirst({
      where: {
        userId: user.id,
        leaderEventId: leaderEvent.id,
      },
    });

    if (existingAttempt) {
      this.logger.debug({ userId: user.id, eventId: leaderEvent.id }, 'Duplicate copy attempt, skipping');
      return;
    }

    // Create pending copy attempt
    const attempt = await this.prisma.copyAttempt.create({
      data: {
        userId: user.id,
        leaderEventId: leaderEvent.id,
        status: 'PENDING',
      },
    });

    try {
      const profile = user.copyProfile;
      if (!profile) return;

      // Get open orders for guardrail evaluation
      const openOrders = await this.prisma.order.findMany({
        where: { userId: user.id, status: 'OPEN' },
      });

      // Evaluate guardrails
      const result = evaluateGuardrails({
        profile,
        openOrders,
        leaderSide: leaderEvent.side,
        leaderPrice: leaderEvent.price,
        leaderSize: leaderEvent.size,
        currentBalance: 0, // TODO: fetch real balance from position sync
      });

      if (!result.allowed) {
        await this.prisma.copyAttempt.update({
          where: { id: attempt.id },
          data: { status: 'SKIPPED', skipReason: result.skipReason },
        });
        this.logger.info({ userId: user.id, reason: result.skipReason }, 'Copy skipped');
        return;
      }

      // Get trading authority address and proxy
      const proxyWallet = user.wallets.find((w: any) => w.type === 'POLY_PROXY');
      const creds = user.polymarketCredentials;

      if (!proxyWallet || !creds) {
        await this.prisma.copyAttempt.update({
          where: { id: attempt.id },
          data: { status: 'FAILED', errorMessage: 'Missing proxy wallet or credentials' },
        });
        return;
      }

      // Check server wallet is ready
      const serverWallet = user.serverWallet;
      const tradingEoa = user.wallets.find((w: any) => w.type === 'TRADING_EOA');

      if (!serverWallet?.address && !tradingEoa) {
        await this.prisma.copyAttempt.update({
          where: { id: attempt.id },
          data: { status: 'FAILED', errorMessage: 'No trading authority available' },
        });
        return;
      }

      // Prefer server wallet, fall back to getting address from provider
      let tradingAddress: string;
      try {
        tradingAddress = await this.tradingAuthority.getAddress(user.id);
      } catch (error) {
        // Dynamic API unavailable — SIGNING_UNAVAILABLE
        const message = error instanceof Error ? error.message : 'Signing unavailable';
        await this.prisma.copyAttempt.update({
          where: { id: attempt.id },
          data: { status: 'FAILED', errorMessage: `SIGNING_UNAVAILABLE: ${message}` },
        });
        this.circuitBreaker.recordFailure();
        this.logger.error({ userId: user.id, err: error }, 'Signing unavailable — copy paused');
        return;
      }

      const adapter = new PolymarketAdapter(
        this.tradingAuthority,
        user.id,
        tradingAddress,
        proxyWallet.address,
        {
          key: creds.apiKey,
          secret: creds.apiSecret,
          passphrase: creds.passphrase,
        },
      );

      const orderResult = await adapter.createOrder({
        tokenId: leaderEvent.tokenId,
        side: leaderEvent.side,
        size: result.adjustedSize,
        price: result.adjustedPrice,
      });

      // Store order
      const order = await this.prisma.order.create({
        data: {
          userId: user.id,
          polyOrderId: orderResult.orderID ?? orderResult.id,
          conditionId: leaderEvent.conditionId,
          tokenId: leaderEvent.tokenId,
          marketSlug: leaderEvent.marketSlug,
          side: leaderEvent.side,
          size: result.adjustedSize,
          price: result.adjustedPrice,
          status: 'OPEN',
        },
      });

      await this.prisma.copyAttempt.update({
        where: { id: attempt.id },
        data: { status: 'SUBMITTED', orderId: order.id },
      });

      this.circuitBreaker.recordSuccess();

      this.logger.info(
        { userId: user.id, orderId: order.id, size: result.adjustedSize },
        'Copy trade submitted',
      );
    } catch (error) {
      this.circuitBreaker.recordFailure();

      const message = error instanceof Error ? error.message : 'Unknown error';
      await this.prisma.copyAttempt.update({
        where: { id: attempt.id },
        data: { status: 'FAILED', errorMessage: message },
      });

      this.logger.error({ userId: user.id, err: error }, 'Copy trade failed');
    }
  }
}
