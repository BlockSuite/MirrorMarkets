import { PrismaClient } from '@prisma/client';
import type { TradingAuthorityProvider } from '@mirrormarkets/shared';
import { DynamicServerWalletProvider } from './dynamic-server-wallet.provider.js';
import { MockDynamicServerWalletProvider } from './mock-server-wallet.provider.js';

let _provider: TradingAuthorityProvider | null = null;

export function getTradingAuthorityProvider(prisma: PrismaClient): TradingAuthorityProvider {
  if (_provider) return _provider;

  const apiKey = process.env.DYNAMIC_API_KEY ?? '';
  const nodeEnv = process.env.NODE_ENV ?? 'development';

  if (apiKey && nodeEnv === 'production') {
    _provider = new DynamicServerWalletProvider(prisma);
  } else {
    _provider = new MockDynamicServerWalletProvider(prisma);
  }

  return _provider;
}

export function resetTradingAuthorityProvider(): void {
  _provider = null;
}
