import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import type {
  TradingAuthorityProvider,
  EIP712TypedData,
  TransactionRequest,
  TransactionResult,
  SigningPurpose,
} from '@mirrormarkets/shared';
import { AppError, ErrorCodes, SIGNING_CONFIG } from '@mirrormarkets/shared';
import { DynamicApiAdapter, DynamicApiError } from './dynamic-api.adapter.js';
import { SigningRequestService } from '../services/signing-request.service.js';
import { SigningRateLimiter } from '../services/signing-rate-limiter.js';
import { SigningCircuitBreaker } from '../services/signing-circuit-breaker.js';
import { AuditService } from '../services/audit.service.js';

/**
 * DynamicServerWalletProvider
 *
 * Production implementation of TradingAuthorityProvider that delegates all
 * signing to Dynamic.xyz Server Wallets (MPC-backed).  The backend NEVER
 * sees or stores raw private keys.
 *
 * Enhanced in Phase 2A with:
 *   - DynamicApiAdapter: thin boundary for Dynamic API calls
 *   - SigningRequestService: audit trail for every signing operation
 *   - SigningRateLimiter: per-user and global rate limits
 *   - SigningCircuitBreaker: auto-degradation on Dynamic API failures
 *   - Retry with exponential backoff
 */
export class DynamicServerWalletProvider implements TradingAuthorityProvider {
  private adapter: DynamicApiAdapter;
  private signingService: SigningRequestService;
  private rateLimiter: SigningRateLimiter;
  private circuitBreaker: SigningCircuitBreaker;
  private auditService: AuditService;

  constructor(
    private prisma: PrismaClient,
    deps?: {
      adapter?: DynamicApiAdapter;
      signingService?: SigningRequestService;
      rateLimiter?: SigningRateLimiter;
      circuitBreaker?: SigningCircuitBreaker;
      auditService?: AuditService;
    },
  ) {
    this.auditService = deps?.auditService ?? new AuditService(prisma);
    this.adapter = deps?.adapter ?? new DynamicApiAdapter();
    this.signingService = deps?.signingService ?? new SigningRequestService(prisma);
    this.rateLimiter = deps?.rateLimiter ?? new SigningRateLimiter(this.auditService);
    this.circuitBreaker = deps?.circuitBreaker ?? new SigningCircuitBreaker(this.auditService);
  }

  // ── Accessors for health check / admin ──────────────────────────────

  getCircuitBreaker(): SigningCircuitBreaker {
    return this.circuitBreaker;
  }

  getRateLimiter(): SigningRateLimiter {
    return this.rateLimiter;
  }

  // ── Core Interface ──────────────────────────────────────────────────

  async getAddress(userId: string): Promise<string> {
    const sw = await this.prisma.serverWallet.findUnique({ where: { userId } });

    // Replace mock wallets from development/testing with real ones
    if (sw && sw.dynamicServerWalletId.startsWith('mock-')) {
      return this.createServerWallet(userId, true);
    }

    if (sw && sw.status === 'READY') return sw.address;
    if (sw && sw.status === 'CREATING') {
      const fresh = await this.adapter.getWallet(sw.dynamicServerWalletId);
      if (fresh.status === 'active' || fresh.status === 'ready') {
        await this.prisma.serverWallet.update({
          where: { id: sw.id },
          data: { status: 'READY', address: fresh.address },
        });
        return fresh.address;
      }
      throw new AppError(
        ErrorCodes.SERVER_WALLET_NOT_READY,
        'Server wallet is still being created',
        503,
      );
    }

    return this.createServerWallet(userId);
  }

  async signTypedData(userId: string, typedData: EIP712TypedData): Promise<string> {
    return this.executeWithTracking({
      userId,
      requestType: 'TYPED_DATA',
      purpose: 'CLOB_ORDER',
      payload: typedData,
      execute: async (walletId) => this.adapter.signTypedData(walletId, typedData),
    });
  }

  async signMessage(userId: string, message: string | Uint8Array): Promise<string> {
    const messageStr = typeof message === 'string'
      ? message
      : Buffer.from(message).toString('hex');

    return this.executeWithTracking({
      userId,
      requestType: 'MESSAGE',
      purpose: 'CLOB_API_KEY',
      payload: { message: messageStr },
      execute: async (walletId) => this.adapter.signMessage(walletId, messageStr),
    });
  }

  async executeTransaction(userId: string, tx: TransactionRequest): Promise<TransactionResult> {
    const sw = await this.requireReadyWallet(userId);
    await this.rateLimiter.checkAndIncrement(userId);
    await this.circuitBreaker.allowRequest();

    const input = this.signingService.buildRequestInput({
      userId,
      requestType: 'TX',
      purpose: 'WITHDRAW',
      payload: tx,
      provider: 'DYNAMIC_SERVER_WALLET',
    });

    const { id: requestId } = await this.signingService.create(input);
    await this.signingService.markSent(requestId);

    try {
      const result = await this.retryWithBackoff(
        () => this.adapter.sendTransaction(sw.address, tx),
      );

      await this.signingService.markSucceeded(requestId, result.hash);
      await this.circuitBreaker.recordSuccess();

      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown';
      await this.signingService.markFailed(requestId, errorMsg);
      await this.circuitBreaker.recordFailure();
      throw this.wrapSigningError(error);
    }
  }

  async rotate(userId: string): Promise<void> {
    const oldWallet = await this.prisma.serverWallet.findUnique({ where: { userId } });
    if (!oldWallet) throw new AppError(ErrorCodes.NOT_FOUND, 'No server wallet to rotate', 404);

    const newAddress = await this.createServerWallet(userId, true);

    await this.auditService.log({
      userId,
      action: 'OWNERSHIP_TRANSFERRED',
      details: {
        oldAddress: oldWallet.address,
        newAddress,
        note: 'Server wallet rotated — Proxy/Safe ownership transfer required',
      },
    });
  }

  async revoke(userId: string): Promise<void> {
    const sw = await this.prisma.serverWallet.findUnique({ where: { userId } });
    if (!sw) return;

    await this.prisma.serverWallet.update({
      where: { id: sw.id },
      data: { status: 'FAILED', lastError: 'Wallet revoked' },
    });

    await this.prisma.copyProfile.updateMany({
      where: { userId, status: 'ENABLED' },
      data: { status: 'PAUSED' },
    });

    await this.auditService.log({
      userId,
      action: 'SERVER_WALLET_FAILED',
      details: { reason: 'Wallet revoked', walletId: sw.dynamicServerWalletId },
    });
  }

  // ── Unified signing flow with tracking ──────────────────────────────

  private async executeWithTracking(params: {
    userId: string;
    requestType: 'TYPED_DATA' | 'MESSAGE';
    purpose: SigningPurpose;
    payload: unknown;
    execute: (walletId: string) => Promise<string>;
  }): Promise<string> {
    const { userId, requestType, purpose, payload, execute } = params;

    // Pre-flight checks
    await this.rateLimiter.checkAndIncrement(userId);
    await this.circuitBreaker.allowRequest();

    const sw = await this.requireReadyWallet(userId);

    // Build and check signing request idempotency
    const input = this.signingService.buildRequestInput({
      userId,
      requestType,
      purpose,
      payload,
      provider: 'DYNAMIC_SERVER_WALLET',
    });

    // Idempotency check — return cached signature if already succeeded
    const cached = await this.signingService.findByIdempotencyKey(input.idempotencyKey);
    if (cached) return cached;

    // Create tracking record
    const { id: requestId, correlationId } = await this.signingService.create(input);

    await this.auditService.log({
      userId,
      action: 'SIGN_REQUEST_SENT',
      details: { correlationId, requestType, purpose },
    });

    await this.signingService.markSent(requestId);

    try {
      const signature = await this.retryWithBackoff(() => execute(sw.address));

      await this.signingService.markSucceeded(requestId, signature);
      await this.circuitBreaker.recordSuccess();

      await this.auditService.log({
        userId,
        action: 'SIGN_REQUEST_SUCCEEDED',
        details: { correlationId },
      });

      return signature;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown';

      await this.signingService.markFailed(requestId, errorMsg);
      await this.circuitBreaker.recordFailure();

      await this.auditService.log({
        userId,
        action: 'SIGN_REQUEST_FAILED',
        details: { correlationId, error: errorMsg },
      });

      throw this.wrapSigningError(error);
    }
  }

  // ── Server wallet creation ──────────────────────────────────────────

  private async createServerWallet(userId: string, isRotation = false): Promise<string> {
    let sw = await this.prisma.serverWallet.findUnique({ where: { userId } });
    if (sw && sw.status === 'READY' && !isRotation) return sw.address;

    try {
      const created = await this.retryWithBackoff(
        () => this.adapter.createWallet(userId),
      );

      if (sw) {
        await this.prisma.serverWallet.update({
          where: { id: sw.id },
          data: {
            dynamicServerWalletId: created.walletId,
            address: created.address,
            status: 'READY',
            lastError: null,
          },
        });
      } else {
        await this.prisma.serverWallet.create({
          data: {
            userId,
            dynamicServerWalletId: created.walletId,
            address: created.address,
            status: 'READY',
          },
        });
      }

      await this.prisma.wallet.upsert({
        where: { userId_type: { userId, type: 'SERVER_WALLET' } },
        create: { userId, type: 'SERVER_WALLET', address: created.address },
        update: { address: created.address },
      });

      await this.auditService.log({
        userId,
        action: 'SERVER_WALLET_CREATED',
        details: {
          dynamicWalletId: created.walletId,
          address: created.address,
          isRotation,
        },
      });

      return created.address;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown';

      if (!sw) {
        await this.prisma.serverWallet.create({
          data: {
            userId,
            dynamicServerWalletId: `pending-${randomUUID()}`,
            address: '0x0000000000000000000000000000000000000000',
            status: 'FAILED',
            lastError: errorMsg,
          },
        });
      } else {
        await this.prisma.serverWallet.update({
          where: { id: sw.id },
          data: { status: 'FAILED', lastError: errorMsg },
        });
      }

      await this.auditService.log({
        userId,
        action: 'SERVER_WALLET_FAILED',
        details: { error: errorMsg },
      });

      throw new AppError(
        ErrorCodes.SERVER_WALLET_CREATION_FAILED,
        `Failed to create server wallet: ${errorMsg}`,
        503,
      );
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private async requireReadyWallet(userId: string) {
    const sw = await this.prisma.serverWallet.findUnique({ where: { userId } });
    if (!sw || sw.status !== 'READY') {
      throw new AppError(
        ErrorCodes.SERVER_WALLET_NOT_READY,
        'Server wallet is not ready for signing',
        503,
      );
    }
    return sw;
  }

  /**
   * Retry with exponential backoff. Handles DynamicApiError rate limiting.
   */
  private async retryWithBackoff<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt <= SIGNING_CONFIG.MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (attempt >= SIGNING_CONFIG.MAX_RETRY_ATTEMPTS) throw error;

        if (error instanceof DynamicApiError && error.errorType === 'RATE_LIMITED') {
          const delay = (error.retryAfterSeconds ?? 2) * 1000;
          await sleep(delay);
          continue;
        }

        if (error instanceof AppError) throw error;

        const delay = SIGNING_CONFIG.RETRY_DELAY_MS * Math.pow(SIGNING_CONFIG.RETRY_BACKOFF_FACTOR, attempt);
        await sleep(delay);
      }
    }
    throw new Error('Exhausted retries');
  }

  private wrapSigningError(error: unknown): AppError {
    if (error instanceof AppError) return error;
    const message = error instanceof Error ? error.message : 'Unknown signing error';
    return new AppError(ErrorCodes.SIGNING_UNAVAILABLE, message, 503);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
