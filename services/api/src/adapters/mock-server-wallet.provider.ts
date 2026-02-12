import { PrismaClient } from '@prisma/client';
import { Wallet, ethers } from 'ethers';
import { randomUUID } from 'crypto';
import type {
  TradingAuthorityProvider,
  EIP712TypedData,
  TransactionRequest,
  TransactionResult,
} from '@mirrormarkets/shared';
import { AppError, ErrorCodes } from '@mirrormarkets/shared';

/**
 * MockDynamicServerWalletProvider
 *
 * Drop-in replacement for DynamicServerWalletProvider that uses
 * deterministic test keys derived from the userId.  Suitable for:
 *   - Local development (`NODE_ENV=development` without DYNAMIC_API_KEY)
 *   - Automated tests
 *
 * The mock NEVER calls external APIs.  It stores ephemeral ethers.Wallet
 * instances in memory keyed by userId, and persists the same address
 * in the ServerWallet table so the rest of the codebase behaves identically.
 *
 * Key derivation: keccak256(utf8(userId)) → private key.  This means
 * the same userId always produces the same address, making tests
 * deterministic.
 */
export class MockDynamicServerWalletProvider implements TradingAuthorityProvider {
  /** In-memory signer cache — never persisted */
  private signers = new Map<string, Wallet>();

  constructor(private prisma: PrismaClient) {}

  // ── Core Interface ─────────────────────────────────────────────────

  async getAddress(userId: string): Promise<string> {
    const sw = await this.prisma.serverWallet.findUnique({ where: { userId } });
    if (sw && sw.status === 'READY') {
      this.ensureSigner(userId);
      return sw.address;
    }

    return this.createMockWallet(userId);
  }

  async signTypedData(userId: string, typedData: EIP712TypedData): Promise<string> {
    const signer = this.ensureSigner(userId);
    await this.requireReady(userId);

    const signature = await signer.signTypedData(
      typedData.domain as ethers.TypedDataDomain,
      // Remove EIP712Domain from types if present
      Object.fromEntries(
        Object.entries(typedData.types).filter(([k]) => k !== 'EIP712Domain'),
      ),
      typedData.message,
    );

    return signature;
  }

  async signMessage(userId: string, message: string | Uint8Array): Promise<string> {
    const signer = this.ensureSigner(userId);
    await this.requireReady(userId);

    const msgBytes = typeof message === 'string'
      ? ethers.toUtf8Bytes(message)
      : message;

    return signer.signMessage(msgBytes);
  }

  async executeTransaction(userId: string, tx: TransactionRequest): Promise<TransactionResult> {
    await this.requireReady(userId);
    // Mock: return a deterministic fake hash
    const hash = ethers.keccak256(ethers.toUtf8Bytes(`${userId}:${tx.to}:${tx.data}`));
    return { hash, status: 'submitted' };
  }

  async rotate(userId: string): Promise<void> {
    // Generate a new deterministic key based on userId + timestamp
    const newSeed = ethers.keccak256(ethers.toUtf8Bytes(`${userId}:${Date.now()}`));
    const newWallet = new Wallet(newSeed);
    this.signers.set(userId, newWallet);

    const sw = await this.prisma.serverWallet.findUnique({ where: { userId } });
    if (sw) {
      await this.prisma.serverWallet.update({
        where: { id: sw.id },
        data: {
          address: newWallet.address,
          dynamicServerWalletId: `mock-${randomUUID()}`,
        },
      });
      await this.prisma.wallet.upsert({
        where: { userId_type: { userId, type: 'SERVER_WALLET' } },
        create: { userId, type: 'SERVER_WALLET', address: newWallet.address },
        update: { address: newWallet.address },
      });
    }
  }

  async revoke(userId: string): Promise<void> {
    this.signers.delete(userId);
    const sw = await this.prisma.serverWallet.findUnique({ where: { userId } });
    if (sw) {
      await this.prisma.serverWallet.update({
        where: { id: sw.id },
        data: { status: 'FAILED' },
      });
    }
    await this.prisma.copyProfile.updateMany({
      where: { userId, status: 'ENABLED' },
      data: { status: 'PAUSED' },
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private ensureSigner(userId: string): Wallet {
    if (!this.signers.has(userId)) {
      const seed = ethers.keccak256(ethers.toUtf8Bytes(userId));
      this.signers.set(userId, new Wallet(seed));
    }
    return this.signers.get(userId)!;
  }

  private async createMockWallet(userId: string): Promise<string> {
    const signer = this.ensureSigner(userId);
    const mockDynamicId = `mock-${randomUUID()}`;

    const existing = await this.prisma.serverWallet.findUnique({ where: { userId } });
    if (existing) {
      await this.prisma.serverWallet.update({
        where: { id: existing.id },
        data: {
          dynamicServerWalletId: mockDynamicId,
          address: signer.address,
          status: 'READY',
        },
      });
    } else {
      await this.prisma.serverWallet.create({
        data: {
          userId,
          dynamicServerWalletId: mockDynamicId,
          address: signer.address,
          status: 'READY',
        },
      });
    }

    await this.prisma.wallet.upsert({
      where: { userId_type: { userId, type: 'SERVER_WALLET' } },
      create: { userId, type: 'SERVER_WALLET', address: signer.address },
      update: { address: signer.address },
    });

    return signer.address;
  }

  private async requireReady(userId: string): Promise<void> {
    const sw = await this.prisma.serverWallet.findUnique({ where: { userId } });
    if (!sw || sw.status !== 'READY') {
      throw new AppError(
        ErrorCodes.SERVER_WALLET_NOT_READY,
        'Mock server wallet is not ready',
        503,
      );
    }
  }
}
