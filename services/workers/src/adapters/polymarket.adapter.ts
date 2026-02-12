import { ClobClient } from '@polymarket/clob-client';
import { Side, AssetType } from '@polymarket/clob-client/dist/types.js';
import { SIGNATURE_TYPE, POLYGON_CHAIN_ID } from '@mirrormarkets/shared';
import type { TradingAuthorityProvider } from '@mirrormarkets/shared';
import { ServerWalletSigner } from './server-wallet-signer.js';

export interface PolymarketApiCredentials {
  key: string;
  secret: string;
  passphrase: string;
}

export interface CreateOrderParams {
  tokenId: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
}

/**
 * PolymarketAdapter — Worker-side, Phase 2A.
 * Uses ServerWalletSigner instead of raw ethers.Wallet.
 */
export class PolymarketAdapter {
  private client: ClobClient;

  constructor(
    tradingAuthority: TradingAuthorityProvider,
    userId: string,
    tradingAddress: string,
    proxyAddress: string,
    credentials: PolymarketApiCredentials,
  ) {
    const clobUrl = process.env.POLYMARKET_CLOB_API_URL ?? 'https://clob.polymarket.com';
    const signer = new ServerWalletSigner(tradingAuthority, userId, tradingAddress);

    this.client = new ClobClient(
      clobUrl,
      POLYGON_CHAIN_ID,
      signer as any,
      credentials,
      SIGNATURE_TYPE.POLY_PROXY,
      proxyAddress,
    );
  }

  async createOrder(params: CreateOrderParams): Promise<any> {
    const order = await this.client.createOrder({
      tokenID: params.tokenId,
      side: params.side === 'BUY' ? Side.BUY : Side.SELL,
      size: params.size,
      price: params.price,
    });
    return this.client.postOrder(order);
  }

  async cancelOrder(orderId: string): Promise<any> {
    return this.client.cancelOrder({ orderID: orderId });
  }
}
