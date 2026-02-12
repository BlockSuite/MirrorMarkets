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
 * MockDynamicServerWalletProvider — Worker-side.
 * Uses deterministic keys derived from userId. No external API calls.
 */
export class MockDynamicServerWalletProvider implements TradingAuthorityProvider {
  private signers = new Map<string, Wallet>();

  constructor(private prisma: PrismaClient) {}

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
    return signer.signTypedData(
      typedData.domain as ethers.TypedDataDomain,
      Object.fromEntries(Object.entries(typedData.types).filter(([k]) => k !== 'EIP712Domain')),
      typedData.message,
    );
  }

  async signMessage(userId: string, message: string | Uint8Array): Promise<string> {
    const signer = this.ensureSigner(userId);
    const msgBytes = typeof message === 'string' ? ethers.toUtf8Bytes(message) : message;
    return signer.signMessage(msgBytes);
  }

  async executeTransaction(userId: string, tx: TransactionRequest): Promise<TransactionResult> {
    const hash = ethers.keccak256(ethers.toUtf8Bytes(`${userId}:${tx.to}:${tx.data}`));
    return { hash, status: 'submitted' };
  }

  private ensureSigner(userId: string): Wallet {
    if (!this.signers.has(userId)) {
      const seed = ethers.keccak256(ethers.toUtf8Bytes(userId));
      this.signers.set(userId, new Wallet(seed));
    }
    return this.signers.get(userId)!;
  }

  private async createMockWallet(userId: string): Promise<string> {
    const signer = this.ensureSigner(userId);
    const mockId = `mock-${randomUUID()}`;

    const existing = await this.prisma.serverWallet.findUnique({ where: { userId } });
    if (existing) {
      await this.prisma.serverWallet.update({
        where: { id: existing.id },
        data: { dynamicServerWalletId: mockId, address: signer.address, status: 'READY' },
      });
    } else {
      await this.prisma.serverWallet.create({
        data: { userId, dynamicServerWalletId: mockId, address: signer.address, status: 'READY' },
      });
    }

    await this.prisma.wallet.upsert({
      where: { userId_type: { userId, type: 'SERVER_WALLET' } },
      create: { userId, type: 'SERVER_WALLET', address: signer.address },
      update: { address: signer.address },
    });

    return signer.address;
  }
}
