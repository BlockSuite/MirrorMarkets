import { PrismaClient } from '@prisma/client';
import type { TradingAuthorityProvider } from '@mirrormarkets/shared';
import { NotFoundError, AppError, ErrorCodes } from '@mirrormarkets/shared';
import { PolymarketAdapter } from '../adapters/polymarket.adapter.js';
import { RelayerAdapter } from '../adapters/relayer.adapter.js';

/**
 * WalletService — Phase 2A
 *
 * Replaces direct private-key decryption with TradingAuthorityProvider
 * calls.  All signing goes through the provider; no raw keys are touched.
 */
export class WalletService {
  constructor(
    private prisma: PrismaClient,
    private tradingAuthority: TradingAuthorityProvider,
  ) {}

  /**
   * Returns the trading authority address and the proxy address
   * for the given user.
   */
  async getTradingAddressAndProxy(userId: string): Promise<{
    tradingAddress: string;
    proxyAddress: string;
  }> {
    const tradingAddress = await this.tradingAuthority.getAddress(userId);

    const proxyWallet = await this.prisma.wallet.findUnique({
      where: { userId_type: { userId, type: 'POLY_PROXY' } },
    });

    if (!proxyWallet) {
      throw new NotFoundError('Proxy wallet');
    }

    return { tradingAddress, proxyAddress: proxyWallet.address };
  }

  /**
   * Returns a PolymarketAdapter configured for the user's server wallet.
   *
   * The adapter wraps the CLOB client and needs a signer object.
   * Phase 2A passes a ServerWalletSigner that proxies all sign calls
   * through the TradingAuthorityProvider.
   */
  async getPolymarketAdapter(userId: string): Promise<PolymarketAdapter> {
    const { tradingAddress, proxyAddress } = await this.getTradingAddressAndProxy(userId);

    const creds = await this.prisma.polymarketCredentials.findUnique({
      where: { userId },
    });

    if (!creds) {
      throw new NotFoundError('Polymarket credentials');
    }

    return new PolymarketAdapter(
      this.tradingAuthority,
      userId,
      tradingAddress,
      proxyAddress,
      {
        key: creds.apiKey,
        secret: creds.apiSecret,
        passphrase: creds.passphrase,
      },
    );
  }

  /**
   * Returns a RelayerAdapter configured for the user's server wallet.
   */
  async getRelayerAdapter(userId: string): Promise<RelayerAdapter> {
    const { tradingAddress, proxyAddress } = await this.getTradingAddressAndProxy(userId);
    return new RelayerAdapter(this.tradingAuthority, userId, tradingAddress, proxyAddress);
  }
}
