import type { TradingAuthorityProvider, EIP712TypedData } from '@mirrormarkets/shared';

/**
 * ServerWalletSigner — Worker-side copy.
 * Identical to the API-side signer. Duck-types ethers v5 Signer.
 */
export class ServerWalletSigner {
  public readonly provider = null;

  constructor(
    private tradingAuthority: TradingAuthorityProvider,
    private userId: string,
    private _address: string,
  ) {}

  async getAddress(): Promise<string> {
    return this._address;
  }

  async signMessage(message: string | Uint8Array): Promise<string> {
    return this.tradingAuthority.signMessage(this.userId, message);
  }

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

  async signTypedData(
    domain: Record<string, unknown>,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>,
  ): Promise<string> {
    return this._signTypedData(domain, types, value);
  }

  connect(): this {
    return this;
  }
}
