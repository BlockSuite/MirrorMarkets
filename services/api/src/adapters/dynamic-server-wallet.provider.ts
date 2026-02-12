import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import type {
  TradingAuthorityProvider,
  EIP712TypedData,
  TransactionRequest,
  TransactionResult,
} from '@mirrormarkets/shared';
import { AppError, ErrorCodes } from '@mirrormarkets/shared';
import { getConfig } from '../config.js';

// ── Constants ──────────────────────────────────────────────────────────

const DYNAMIC_API_BASE = 'https://app.dynamicauth.com/api/v0';
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500; // exponential backoff base

// ── Types (mapped from Dynamic REST API responses) ─────────────────────

interface DynamicCreateWalletResponse {
  id: string;
  address: string;
  chain: string;
  name: string;
  status: string;
}

interface DynamicSignResponse {
  signature: string;
}

// ── Implementation ─────────────────────────────────────────────────────

/**
 * DynamicServerWalletProvider
 *
 * Production implementation of TradingAuthorityProvider that delegates all
 * signing to Dynamic.xyz Server Wallets (MPC-backed).  The backend NEVER
 * sees or stores raw private keys.
 *
 * API reference (verify against latest Dynamic docs):
 *   POST /server-wallets            → create wallet
 *   GET  /server-wallets/:id        → get wallet info
 *   POST /server-wallets/:id/sign   → sign arbitrary message
 *   POST /server-wallets/:id/sign-typed-data → sign EIP-712
 *   POST /server-wallets/:id/sign-transaction → sign + broadcast tx
 *
 * Items on the Docs Verification Checklist are marked with [DVC-n].
 */
export class DynamicServerWalletProvider implements TradingAuthorityProvider {
  constructor(private prisma: PrismaClient) {}

  // ── Core Interface ─────────────────────────────────────────────────

  async getAddress(userId: string): Promise<string> {
    const sw = await this.prisma.serverWallet.findUnique({ where: { userId } });

    if (sw && sw.status === 'READY') return sw.address;
    if (sw && sw.status === 'CREATING') {
      // Poll Dynamic to see if it became ready
      const fresh = await this.fetchWalletFromDynamic(sw.dynamicServerWalletId);
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

    // No wallet yet — create one
    return this.createServerWallet(userId);
  }

  async signTypedData(userId: string, typedData: EIP712TypedData): Promise<string> {
    const correlationId = randomUUID();
    const sw = await this.requireReadyWallet(userId);

    await this.auditSigningRequest(userId, correlationId, 'signTypedData');

    try {
      // [DVC-1] Verify exact request body shape against Dynamic docs
      const result = await this.callDynamicWithRetry<DynamicSignResponse>(
        `server-wallets/${sw.dynamicServerWalletId}/sign-typed-data`,
        'POST',
        {
          typedData: JSON.stringify(typedData),
          chain: 'EVM',
        },
      );

      await this.auditSigningComplete(userId, correlationId);
      return result.signature;
    } catch (error) {
      await this.auditSigningFailed(userId, correlationId, error);
      throw this.wrapSigningError(error);
    }
  }

  async signMessage(userId: string, message: string | Uint8Array): Promise<string> {
    const correlationId = randomUUID();
    const sw = await this.requireReadyWallet(userId);

    await this.auditSigningRequest(userId, correlationId, 'signMessage');

    try {
      const messageStr = typeof message === 'string'
        ? message
        : Buffer.from(message).toString('hex');

      // [DVC-2] Verify sign endpoint and encoding (hex vs utf8)
      const result = await this.callDynamicWithRetry<DynamicSignResponse>(
        `server-wallets/${sw.dynamicServerWalletId}/sign`,
        'POST',
        {
          message: messageStr,
          encoding: typeof message === 'string' ? 'utf8' : 'hex',
          chain: 'EVM',
        },
      );

      await this.auditSigningComplete(userId, correlationId);
      return result.signature;
    } catch (error) {
      await this.auditSigningFailed(userId, correlationId, error);
      throw this.wrapSigningError(error);
    }
  }

  async executeTransaction(userId: string, tx: TransactionRequest): Promise<TransactionResult> {
    const correlationId = randomUUID();
    const sw = await this.requireReadyWallet(userId);

    await this.auditSigningRequest(userId, correlationId, 'executeTransaction');

    try {
      // [DVC-3] Verify transaction execution endpoint and response shape
      const result = await this.callDynamicWithRetry<{ hash: string; status: string }>(
        `server-wallets/${sw.dynamicServerWalletId}/sign-transaction`,
        'POST',
        {
          transaction: {
            to: tx.to,
            data: tx.data,
            value: tx.value ?? '0',
            chainId: tx.chainId ?? 137,
          },
          chain: 'EVM',
          broadcast: true,
        },
      );

      await this.auditSigningComplete(userId, correlationId);
      return {
        hash: result.hash,
        status: result.status === 'confirmed' ? 'confirmed' : 'submitted',
      };
    } catch (error) {
      await this.auditSigningFailed(userId, correlationId, error);
      throw this.wrapSigningError(error);
    }
  }

  async rotate(userId: string): Promise<void> {
    const oldWallet = await this.prisma.serverWallet.findUnique({ where: { userId } });
    if (!oldWallet) throw new AppError(ErrorCodes.NOT_FOUND, 'No server wallet to rotate', 404);

    // Create a new server wallet
    const newAddress = await this.createServerWallet(userId, true);

    await this.prisma.auditLog.create({
      data: {
        userId,
        action: 'OWNERSHIP_TRANSFERRED',
        details: {
          oldAddress: oldWallet.address,
          newAddress,
          note: 'Server wallet rotated — Proxy/Safe ownership transfer required',
        },
      },
    });
  }

  async revoke(userId: string): Promise<void> {
    const sw = await this.prisma.serverWallet.findUnique({ where: { userId } });
    if (!sw) return;

    await this.prisma.serverWallet.update({
      where: { id: sw.id },
      data: { status: 'FAILED' },
    });

    // Pause copy trading
    await this.prisma.copyProfile.updateMany({
      where: { userId, status: 'ENABLED' },
      data: { status: 'PAUSED' },
    });

    await this.prisma.auditLog.create({
      data: {
        userId,
        action: 'SERVER_WALLET_FAILED',
        details: { reason: 'Wallet revoked', walletId: sw.dynamicServerWalletId },
      },
    });
  }

  // ── Server wallet creation ─────────────────────────────────────────

  private async createServerWallet(userId: string, isRotation = false): Promise<string> {
    const config = getConfig();

    // Mark as creating (upsert handles idempotent re-calls)
    let sw = await this.prisma.serverWallet.findUnique({ where: { userId } });
    if (sw && sw.status === 'READY' && !isRotation) return sw.address;

    try {
      // [DVC-4] Verify create server wallet endpoint and required fields
      const created = await this.callDynamicWithRetry<DynamicCreateWalletResponse>(
        'server-wallets',
        'POST',
        {
          chain: 'EVM',
          name: `mirror-${userId.slice(0, 8)}`,
        },
      );

      if (sw && isRotation) {
        // Replace existing record
        await this.prisma.serverWallet.update({
          where: { id: sw.id },
          data: {
            dynamicServerWalletId: created.id,
            address: created.address,
            status: 'READY',
          },
        });
      } else if (sw) {
        await this.prisma.serverWallet.update({
          where: { id: sw.id },
          data: {
            dynamicServerWalletId: created.id,
            address: created.address,
            status: 'READY',
          },
        });
      } else {
        await this.prisma.serverWallet.create({
          data: {
            userId,
            dynamicServerWalletId: created.id,
            address: created.address,
            status: 'READY',
          },
        });
      }

      // Also store in wallets table for compatibility
      await this.prisma.wallet.upsert({
        where: { userId_type: { userId, type: 'SERVER_WALLET' } },
        create: { userId, type: 'SERVER_WALLET', address: created.address },
        update: { address: created.address },
      });

      await this.prisma.auditLog.create({
        data: {
          userId,
          action: 'SERVER_WALLET_CREATED',
          details: {
            dynamicWalletId: created.id,
            address: created.address,
            isRotation,
          },
        },
      });

      return created.address;
    } catch (error) {
      // Record failure but allow retry
      if (!sw) {
        await this.prisma.serverWallet.create({
          data: {
            userId,
            dynamicServerWalletId: `pending-${randomUUID()}`,
            address: '0x0000000000000000000000000000000000000000',
            status: 'FAILED',
          },
        });
      } else {
        await this.prisma.serverWallet.update({
          where: { id: sw.id },
          data: { status: 'FAILED' },
        });
      }

      await this.prisma.auditLog.create({
        data: {
          userId,
          action: 'SERVER_WALLET_FAILED',
          details: { error: error instanceof Error ? error.message : 'Unknown' },
        },
      });

      throw new AppError(
        ErrorCodes.SERVER_WALLET_CREATION_FAILED,
        `Failed to create server wallet: ${error instanceof Error ? error.message : 'Unknown'}`,
        503,
      );
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────

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

  private async fetchWalletFromDynamic(walletId: string): Promise<{ address: string; status: string }> {
    const result = await this.callDynamicWithRetry<{ address: string; status: string }>(
      `server-wallets/${walletId}`,
      'GET',
    );
    return result;
  }

  /**
   * Generic HTTP client for Dynamic API with exponential backoff retry,
   * rate-limit handling (429), and timeout.
   */
  private async callDynamicWithRetry<T>(
    path: string,
    method: 'GET' | 'POST',
    body?: Record<string, unknown>,
  ): Promise<T> {
    const config = getConfig();
    const url = `${DYNAMIC_API_BASE}/${path}`;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const headers: Record<string, string> = {
          'Authorization': `Bearer ${config.DYNAMIC_API_KEY}`,
          'Content-Type': 'application/json',
        };

        const res = await fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(15_000),
        });

        if (res.status === 429) {
          // Rate limited — respect Retry-After if present
          const retryAfter = parseInt(res.headers.get('Retry-After') ?? '2', 10);
          const delay = retryAfter * 1000;
          if (attempt < MAX_RETRIES) {
            await sleep(delay);
            continue;
          }
          throw new AppError(ErrorCodes.RATE_LIMITED, 'Dynamic API rate limited', 429);
        }

        if (!res.ok) {
          const errorBody = await res.text();
          throw new Error(`Dynamic API ${method} ${path} failed: ${res.status} ${errorBody}`);
        }

        return (await res.json()) as T;
      } catch (error) {
        if (error instanceof AppError) throw error;

        if (attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt);
          await sleep(delay);
          continue;
        }

        throw error;
      }
    }

    // Should never reach here
    throw new Error('Exhausted retries for Dynamic API call');
  }

  private wrapSigningError(error: unknown): AppError {
    if (error instanceof AppError) return error;
    const message = error instanceof Error ? error.message : 'Unknown signing error';
    return new AppError(ErrorCodes.SIGNING_UNAVAILABLE, message, 503);
  }

  // ── Audit helpers ──────────────────────────────────────────────────

  private async auditSigningRequest(userId: string, correlationId: string, operation: string) {
    await this.prisma.auditLog.create({
      data: {
        userId,
        action: 'SIGNING_REQUESTED',
        details: { correlationId, operation },
      },
    });
  }

  private async auditSigningComplete(userId: string, correlationId: string) {
    await this.prisma.auditLog.create({
      data: {
        userId,
        action: 'SIGNING_COMPLETED',
        details: { correlationId },
      },
    });
  }

  private async auditSigningFailed(userId: string, correlationId: string, error: unknown) {
    await this.prisma.auditLog.create({
      data: {
        userId,
        action: 'SIGNING_FAILED',
        details: {
          correlationId,
          error: error instanceof Error ? error.message : 'Unknown',
        },
      },
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
