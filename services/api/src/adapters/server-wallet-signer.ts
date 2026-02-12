import type { TradingAuthorityProvider, EIP712TypedData } from '@mirrormarkets/shared';

/**
 * ServerWalletSigner
 *
 * A duck-typed object that satisfies the ethers v5 Signer interface
 * used by @polymarket/clob-client.  It forwards all signing operations
 * to the TradingAuthorityProvider.
 *
 * The CLOB client only uses:
 *   - getAddress()
 *   - signMessage(message)
 *   - _signTypedData(domain, types, value)  (ethers v5 name)
 *
 * We implement all three as thin wrappers around the provider.
 *
 * [DVC-6] Verify which signer methods ClobClient actually calls.
 */
export class ServerWalletSigner {
  // ethers v5 Signer fields that the CLOB client may read
  public readonly provider = null;

  constructor(
    private tradingAuthority: TradingAuthorityProvider,
    private userId: string,
    private _address: string,
  ) {}

  async getAddress(): Promise<string> {
    return this._address;
  }

  /**
   * signMessage — called by CLOB client for API key derivation
   * and other non-EIP-712 signatures.
   */
  async signMessage(message: string | Uint8Array): Promise<string> {
    return this.tradingAuthority.signMessage(this.userId, message);
  }

  /**
   * _signTypedData — ethers v5 name for EIP-712 signing.
   * The CLOB client calls this to sign CLOB orders.
   */
  async _signTypedData(
    domain: Record<string, unknown>,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>,
  ): Promise<string> {
    // Filter out EIP712Domain from types — it's represented by the domain field
    const filteredTypes = Object.fromEntries(
      Object.entries(types).filter(([k]) => k !== 'EIP712Domain'),
    );
    const typedData: EIP712TypedData = {
      types: filteredTypes,
      primaryType: Object.keys(filteredTypes)[0] ?? 'Order',
      domain,
      message: value,
    };

    return this.tradingAuthority.signTypedData(this.userId, typedData);
  }

  /**
   * signTypedData — ethers v6 name.  Alias for compatibility.
   */
  async signTypedData(
    domain: Record<string, unknown>,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>,
  ): Promise<string> {
    return this._signTypedData(domain, types, value);
  }

  /**
   * connect — no-op, returns self. Some libraries call signer.connect(provider).
   */
  connect(): this {
    return this;
  }
}
