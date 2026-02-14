import type {
  DynamicServerWalletAdapter,
  EIP712TypedData,
  TransactionRequest,
  TransactionResult,
} from '@mirrormarkets/shared';
import { DynamicEvmWalletClient } from '@dynamic-labs-wallet/node-evm';
import { ThresholdSignatureScheme } from '@dynamic-labs-wallet/node';
import { polygon } from 'viem/chains';
import { getConfig } from '../config.js';

/**
 * Dynamic.xyz Node SDK adapter — thin boundary layer.
 *
 * Uses @dynamic-labs-wallet/node-evm to create and sign with
 * MPC-backed server wallets. The backend never sees raw private keys.
 *
 * Wallet creation: DynamicEvmWalletClient.createWalletAccount()
 * Signing: getWalletClient() → Viem WalletClient methods
 *
 * All retry logic, rate limiting, and circuit breaking live in the
 * TradingAuthorityProvider that wraps this adapter.
 *
 * NOTE: The adapter methods that accept a "walletIdOrAddress" parameter
 * use the wallet's 0x address to obtain a Viem WalletClient for signing.
 */

export class DynamicApiAdapter implements DynamicServerWalletAdapter {
  private evmClient: DynamicEvmWalletClient | null = null;
  private initPromise: Promise<DynamicEvmWalletClient> | null = null;

  /**
   * Lazily create and authenticate the DynamicEvmWalletClient.
   * Thread-safe: concurrent callers share the same init promise.
   */
  private getClient(): Promise<DynamicEvmWalletClient> {
    if (this.evmClient) return Promise.resolve(this.evmClient);
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const config = getConfig();
      const client = new DynamicEvmWalletClient({
        environmentId: config.DYNAMIC_ENVIRONMENT_ID,
      });
      await client.authenticateApiToken(config.DYNAMIC_API_KEY);
      this.evmClient = client;
      return client;
    })();

    this.initPromise.catch(() => {
      // Reset on failure so the next call retries
      this.initPromise = null;
    });

    return this.initPromise;
  }

  async createWallet(userId: string): Promise<{ walletId: string; address: string }> {
    const client = await this.getClient();

    const wallet = await client.createWalletAccount({
      thresholdSignatureScheme: ThresholdSignatureScheme.TWO_OF_TWO,
      backUpToClientShareService: true,
    });

    return {
      walletId: wallet.walletId,
      address: wallet.accountAddress,
    };
  }

  async signMessage(walletAddress: string, message: string): Promise<string> {
    const client = await this.getClient();
    const config = getConfig();

    const walletClient = await client.getWalletClient({
      accountAddress: walletAddress as `0x${string}`,
      chainId: 137,
      rpcUrl: config.POLYGON_RPC_URL,
    });

    return walletClient.signMessage({ message });
  }

  async signTypedData(walletAddress: string, typedData: EIP712TypedData): Promise<string> {
    const client = await this.getClient();
    const config = getConfig();

    const walletClient = await client.getWalletClient({
      accountAddress: walletAddress as `0x${string}`,
      chainId: 137,
      rpcUrl: config.POLYGON_RPC_URL,
    });

    // Filter out EIP712Domain from types (Viem expects only the custom types)
    const types = Object.fromEntries(
      Object.entries(typedData.types).filter(([k]) => k !== 'EIP712Domain'),
    );

    return walletClient.signTypedData({
      domain: typedData.domain as Record<string, unknown>,
      types,
      primaryType: Object.keys(types)[0],
      message: typedData.message as Record<string, unknown>,
    });
  }

  async sendTransaction(walletAddress: string, tx: TransactionRequest): Promise<TransactionResult> {
    const client = await this.getClient();
    const config = getConfig();

    const walletClient = await client.getWalletClient({
      accountAddress: walletAddress as `0x${string}`,
      chainId: tx.chainId ?? 137,
      rpcUrl: config.POLYGON_RPC_URL,
    });

    const hash = await walletClient.sendTransaction({
      to: tx.to as `0x${string}`,
      data: tx.data as `0x${string}` | undefined,
      value: tx.value ? BigInt(tx.value) : undefined,
      chain: polygon,
      account: walletAddress as `0x${string}`,
    });

    return { hash, status: 'submitted' };
  }

  async getWallet(walletId: string): Promise<{ walletId: string; address: string; status: string }> {
    // With the SDK, wallets are created synchronously and are immediately ready.
    // This method is kept for interface compliance but the CREATING state should
    // not occur. If called, we check via the REST API as a fallback.
    const config = getConfig();
    const url = `https://app.dynamicauth.com/api/v0/environments/${config.DYNAMIC_ENVIRONMENT_ID}/wallets?limit=50`;

    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${config.DYNAMIC_API_KEY}` },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      throw new DynamicApiError(
        'API_ERROR',
        `Dynamic API GET wallets failed: ${res.status}`,
        res.status,
      );
    }

    const data = (await res.json()) as { wallets: Array<{ id: string; publicKey: string; name: string }> };
    const wallet = data.wallets.find((w) => w.id === walletId);

    if (!wallet) {
      throw new DynamicApiError('API_ERROR', `Wallet ${walletId} not found`, 404);
    }

    return { walletId: wallet.id, address: wallet.publicKey, status: 'active' };
  }
}

/**
 * Structured error from the Dynamic API adapter.
 * Includes HTTP status and optional retryAfter hint.
 */
export class DynamicApiError extends Error {
  constructor(
    public readonly errorType: 'RATE_LIMITED' | 'API_ERROR' | 'TIMEOUT',
    message: string,
    public readonly httpStatus: number,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'DynamicApiError';
  }
}
