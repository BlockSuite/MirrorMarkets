import { PrismaClient } from '@prisma/client';
import type { TradingAuthorityProvider } from '@mirrormarkets/shared';
import { getConfig } from '../config.js';
import { DynamicServerWalletProvider } from './dynamic-server-wallet.provider.js';
import { MockDynamicServerWalletProvider } from './mock-server-wallet.provider.js';

let _provider: TradingAuthorityProvider | null = null;

/**
 * Returns a singleton TradingAuthorityProvider based on configuration.
 *
 * - Production with DYNAMIC_API_KEY set: DynamicServerWalletProvider
 * - Development / test without key: MockDynamicServerWalletProvider
 *
 * The factory is idempotent — calling it multiple times with the same
 * PrismaClient returns the same instance.
 */
export function getTradingAuthorityProvider(prisma: PrismaClient): TradingAuthorityProvider {
  if (_provider) return _provider;

  const config = getConfig();

  if (config.DYNAMIC_API_KEY && config.NODE_ENV === 'production') {
    _provider = new DynamicServerWalletProvider(prisma);
  } else {
    _provider = new MockDynamicServerWalletProvider(prisma);
  }

  return _provider;
}

/**
 * Reset the singleton — only used in tests.
 */
export function resetTradingAuthorityProvider(): void {
  _provider = null;
}
