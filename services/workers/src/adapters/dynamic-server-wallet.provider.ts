import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import type {
  TradingAuthorityProvider,
  EIP712TypedData,
  TransactionRequest,
  TransactionResult,
} from '@mirrormarkets/shared';
import { AppError, ErrorCodes } from '@mirrormarkets/shared';

const DYNAMIC_API_BASE = 'https://app.dynamicauth.com/api/v0';
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * DynamicServerWalletProvider — Worker-side.
 * Identical logic to the API-side provider but reads config from env vars.
 */
export class DynamicServerWalletProvider implements TradingAuthorityProvider {
  constructor(private prisma: PrismaClient) {}

  async getAddress(userId: string): Promise<string> {
    const sw = await this.prisma.serverWallet.findUnique({ where: { userId } });
    if (sw && sw.status === 'READY') return sw.address;
    throw new AppError(ErrorCodes.SERVER_WALLET_NOT_READY, 'Server wallet not ready', 503);
  }

  async signTypedData(userId: string, typedData: EIP712TypedData): Promise<string> {
    const sw = await this.requireReady(userId);
    const result = await this.callDynamic<{ signature: string }>(
      `server-wallets/${sw.dynamicServerWalletId}/sign-typed-data`,
      'POST',
      { typedData: JSON.stringify(typedData), chain: 'EVM' },
    );
    return result.signature;
  }

  async signMessage(userId: string, message: string | Uint8Array): Promise<string> {
    const sw = await this.requireReady(userId);
    const messageStr = typeof message === 'string'
      ? message
      : Buffer.from(message).toString('hex');
    const result = await this.callDynamic<{ signature: string }>(
      `server-wallets/${sw.dynamicServerWalletId}/sign`,
      'POST',
      {
        message: messageStr,
        encoding: typeof message === 'string' ? 'utf8' : 'hex',
        chain: 'EVM',
      },
    );
    return result.signature;
  }

  async executeTransaction(userId: string, tx: TransactionRequest): Promise<TransactionResult> {
    const sw = await this.requireReady(userId);
    const result = await this.callDynamic<{ hash: string; status: string }>(
      `server-wallets/${sw.dynamicServerWalletId}/sign-transaction`,
      'POST',
      {
        transaction: { to: tx.to, data: tx.data, value: tx.value ?? '0', chainId: tx.chainId ?? 137 },
        chain: 'EVM',
        broadcast: true,
      },
    );
    return { hash: result.hash, status: result.status === 'confirmed' ? 'confirmed' : 'submitted' };
  }

  private async requireReady(userId: string) {
    const sw = await this.prisma.serverWallet.findUnique({ where: { userId } });
    if (!sw || sw.status !== 'READY') {
      throw new AppError(ErrorCodes.SERVER_WALLET_NOT_READY, 'Server wallet not ready', 503);
    }
    return sw;
  }

  private async callDynamic<T>(path: string, method: 'GET' | 'POST', body?: Record<string, unknown>): Promise<T> {
    const apiKey = process.env.DYNAMIC_API_KEY ?? '';
    const url = `${DYNAMIC_API_BASE}/${path}`;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(url, {
          method,
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(15_000),
        });

        if (res.status === 429) {
          const retryAfter = parseInt(res.headers.get('Retry-After') ?? '2', 10);
          if (attempt < MAX_RETRIES) {
            await sleep(retryAfter * 1000);
            continue;
          }
          throw new AppError(ErrorCodes.RATE_LIMITED, 'Dynamic API rate limited', 429);
        }

        if (!res.ok) {
          const errorBody = await res.text();
          throw new Error(`Dynamic API ${method} ${path}: ${res.status} ${errorBody}`);
        }

        return (await res.json()) as T;
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (attempt < MAX_RETRIES) {
          await sleep(BASE_DELAY_MS * Math.pow(2, attempt));
          continue;
        }
        throw error;
      }
    }

    throw new Error('Exhausted retries for Dynamic API');
  }
}
