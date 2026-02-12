/**
 * @deprecated Phase 1 — kept only for the migration script.
 * All new code uses TradingAuthorityProvider.
 */
import { Wallet } from 'ethers';
import { decryptPrivateKey } from '@mirrormarkets/shared';

const ENCRYPTION_KEY = process.env.TRADING_KEY_ENCRYPTION_KEY ?? '';

export class LegacyTradingKeyProvider {
  getWallet(encryptedPrivateKey: string): Wallet {
    const privateKey = decryptPrivateKey(encryptedPrivateKey, ENCRYPTION_KEY);
    return new Wallet(privateKey);
  }
}
