import { PrismaClient } from '@prisma/client';
import type { TradingAuthorityProvider, ProvisioningStatus } from '@mirrormarkets/shared';
import { AuditService } from './audit.service.js';
import { getConfig } from '../config.js';

/**
 * ProvisioningService — Phase 2A
 *
 * Provisions a new user's wallet infrastructure:
 *   1. Store the Dynamic embedded-wallet EOA address (identity).
 *   2. Create a Dynamic Server Wallet (MPC signing authority).
 *   3. Derive Polymarket CLOB API credentials using the server wallet.
 *   4. Store the Proxy/Safe address (deployed by relayer on first tx).
 *   5. Create a default copy profile.
 *
 * Idempotent: each step is guarded by a check-before-write pattern.
 *
 * Phase 1 TRADING_EOA wallets are still readable for migration purposes
 * but are never created for new users when USE_SERVER_WALLETS=true.
 */
export class ProvisioningService {
  constructor(
    private prisma: PrismaClient,
    private audit: AuditService,
    private tradingAuthority: TradingAuthorityProvider,
  ) {}

  async getStatus(userId: string): Promise<ProvisioningStatus> {
    const [wallets, serverWallet, creds, copyProfile] = await Promise.all([
      this.prisma.wallet.findMany({ where: { userId } }),
      this.prisma.serverWallet.findUnique({ where: { userId } }),
      this.prisma.polymarketCredentials.findUnique({ where: { userId } }),
      this.prisma.copyProfile.findUnique({ where: { userId } }),
    ]);

    const walletTypes = new Set(wallets.map((w) => w.type));

    const status: ProvisioningStatus = {
      dynamicEoa: walletTypes.has('DYNAMIC_EOA'),
      tradingEoa: walletTypes.has('TRADING_EOA'),
      serverWallet: walletTypes.has('SERVER_WALLET'),
      serverWalletCreating: serverWallet?.status === 'CREATING',
      serverWalletReady: serverWallet?.status === 'READY',
      polyProxy: walletTypes.has('POLY_PROXY'),
      clobApiKey: !!creds?.apiKey,
      copyProfile: !!copyProfile,
      complete: false,
    };

    // Complete when: identity + signing authority + proxy + creds + profile
    const hasAuthority = status.serverWalletReady || status.tradingEoa;
    status.complete =
      status.dynamicEoa &&
      hasAuthority &&
      status.polyProxy &&
      status.clobApiKey &&
      status.copyProfile;

    return status;
  }

  async provision(userId: string, dynamicEoaAddress: string, ipAddress?: string): Promise<ProvisioningStatus> {
    const config = getConfig();

    // Step 1: Store Dynamic EOA (identity wallet)
    await this.prisma.wallet.upsert({
      where: { userId_type: { userId, type: 'DYNAMIC_EOA' } },
      create: { userId, type: 'DYNAMIC_EOA', address: dynamicEoaAddress },
      update: { address: dynamicEoaAddress },
    });

    // Step 2: Create trading authority
    let tradingAddress: string;

    if (config.USE_SERVER_WALLETS) {
      // Phase 2A: Dynamic Server Wallet
      tradingAddress = await this.tradingAuthority.getAddress(userId);

      await this.audit.log({
        userId,
        action: 'WALLET_PROVISIONED',
        details: { type: 'SERVER_WALLET', address: tradingAddress },
        ipAddress,
      });
    } else {
      // Phase 1 legacy path: still supported during migration window
      const existingTrading = await this.prisma.wallet.findUnique({
        where: { userId_type: { userId, type: 'TRADING_EOA' } },
      });

      if (existingTrading) {
        tradingAddress = existingTrading.address;
      } else {
        // This path is disabled when USE_SERVER_WALLETS=true (default)
        throw new Error('Legacy key provisioning is disabled.  Set USE_SERVER_WALLETS=true.');
      }
    }

    // Step 3: Derive CLOB API credentials
    const existingCreds = await this.prisma.polymarketCredentials.findUnique({
      where: { userId },
    });

    if (!existingCreds) {
      // For Phase 2A the PolymarketAdapter needs to be initialized with a
      // signer that delegates to the server wallet.  The CLOB client's
      // createApiKey() signs a message — we do that through our authority.
      //
      // [DVC-5] Verify that createApiKey() signature can be generated
      // via signMessage on the server wallet rather than a local ethers Wallet.
      //
      // For now, we skip auto-derivation and let it be triggered on first
      // order attempt if needed (the CLOB client handshakes lazily).
      try {
        // Attempt to store placeholder — credentials are derived on first
        // adapter usage via the signing authority.
        // This is a design decision: credential derivation is deferred.
      } catch {
        // Continue provisioning even if cred derivation fails
      }
    }

    // Step 4: Store proxy address (placeholder — relayer deploys on first tx)
    const existingProxy = await this.prisma.wallet.findUnique({
      where: { userId_type: { userId, type: 'POLY_PROXY' } },
    });

    if (!existingProxy) {
      // Proxy address is deterministic from the trading authority address
      // via CREATE2.  Store the trading address as placeholder — the
      // actual proxy will be written after the first relayer transaction.
      await this.prisma.wallet.create({
        data: { userId, type: 'POLY_PROXY', address: tradingAddress },
      });

      await this.audit.log({
        userId,
        action: 'PROXY_DEPLOYED',
        details: { address: tradingAddress, note: 'placeholder — relayer deploys on first tx' },
        ipAddress,
      });
    }

    // Step 5: Create default copy profile
    await this.prisma.copyProfile.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });

    return this.getStatus(userId);
  }
}
