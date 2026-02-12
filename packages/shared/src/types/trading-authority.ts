/**
 * TradingAuthorityProvider — Phase 2A abstraction for signing operations.
 *
 * All code that previously used raw private keys (TradingKeyProvider) must
 * go through this interface instead.  The production implementation delegates
 * to Dynamic Server Wallets (MPC-backed).  A mock implementation exists for
 * local development and testing.
 */

export interface EIP712TypedData {
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  domain: Record<string, unknown>;
  message: Record<string, unknown>;
}

export interface TransactionRequest {
  to: string;
  data: string;
  value?: string;
  chainId?: number;
}

export interface TransactionResult {
  hash: string;
  status: 'submitted' | 'confirmed' | 'failed';
}

export interface TradingAuthorityProvider {
  /**
   * Returns the on-chain address of the trading authority (server wallet)
   * for the given user.  Creates one if it does not exist.
   */
  getAddress(userId: string): Promise<string>;

  /**
   * Signs EIP-712 typed data via the server wallet for the given user.
   * Used for Polymarket CLOB order signing.
   */
  signTypedData(userId: string, typedData: EIP712TypedData): Promise<string>;

  /**
   * Signs an arbitrary message via the server wallet for the given user.
   * Used for relayer payload signing.
   */
  signMessage(userId: string, message: string | Uint8Array): Promise<string>;

  /**
   * Optionally executes a transaction directly through the server wallet.
   * Used when the relayer needs a signed transaction broadcast.
   */
  executeTransaction?(userId: string, tx: TransactionRequest): Promise<TransactionResult>;

  /**
   * Rotates the server wallet for a user.  After rotation:
   *   - The old wallet is decommissioned
   *   - Proxy/Safe ownership is transferred to the new wallet
   *   - CLOB API credentials are re-derived
   */
  rotate?(userId: string): Promise<void>;

  /**
   * Revokes the server wallet for a user.  Used when a wallet is
   * compromised.  After revocation the user's copy trading is paused
   * and they must re-provision.
   */
  revoke?(userId: string): Promise<void>;
}
