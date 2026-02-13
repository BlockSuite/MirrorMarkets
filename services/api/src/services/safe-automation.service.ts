import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'crypto';
import { AppError, ErrorCodes, encryptPrivateKey, decryptPrivateKey, SAFE_MODULE } from '@mirrormarkets/shared';
import type { SafeConstraints } from '@mirrormarkets/shared';
import { Wallet } from 'ethers';
import { AuditService } from './audit.service.js';
import { getConfig } from '../config.js';

/**
 * SafeAutomationService — Phase 2B
 *
 * Manages Safe automation module state:
 *   - Enable/disable module on a user's Safe
 *   - Register/revoke/rotate session keys
 *   - Manage withdrawal allowlist
 *   - Update constraints
 *   - Execute module transactions (via session keys)
 */
export class SafeAutomationService {
  constructor(
    private prisma: PrismaClient,
    private audit: AuditService,
  ) {}

  // ── Module Management ────────────────────────────────────────────

  async getAutomation(userId: string) {
    return this.prisma.safeAutomation.findUnique({ where: { userId } });
  }

  async enableModule(params: {
    userId: string;
    safeAddress: string;
    moduleAddress: string;
    enableTxHash: string;
  }) {
    const existing = await this.prisma.safeAutomation.findUnique({
      where: { userId: params.userId },
    });

    if (existing?.enabled) {
      throw new AppError(ErrorCodes.MODULE_NOT_INSTALLED, 'Module already enabled', 409);
    }

    const automation = await this.prisma.safeAutomation.upsert({
      where: { userId: params.userId },
      create: {
        userId: params.userId,
        safeAddress: params.safeAddress,
        moduleAddress: params.moduleAddress,
        enabled: true,
        enableTxHash: params.enableTxHash,
        enabledAt: new Date(),
        constraints: {},
      },
      update: {
        safeAddress: params.safeAddress,
        moduleAddress: params.moduleAddress,
        enabled: true,
        enableTxHash: params.enableTxHash,
        enabledAt: new Date(),
        disabledAt: null,
      },
    });

    await this.audit.log({
      userId: params.userId,
      action: 'MODULE_ENABLE_CONFIRMED',
      details: {
        safeAddress: params.safeAddress,
        moduleAddress: params.moduleAddress,
        txHash: params.enableTxHash,
      },
    });

    return automation;
  }

  async disableModule(userId: string) {
    const automation = await this.requireEnabled(userId);

    // Revoke all active session keys
    await this.prisma.sessionKey.updateMany({
      where: { userId, status: 'ACTIVE' },
      data: { status: 'REVOKED' },
    });

    await this.prisma.safeAutomation.update({
      where: { userId },
      data: {
        enabled: false,
        disabledAt: new Date(),
        activeSessionKeyId: null,
        sessionKeyPublicAddress: null,
      },
    });

    await this.audit.log({
      userId,
      action: 'MODULE_DISABLED',
      details: { safeAddress: automation.safeAddress },
    });
  }

  async updateSigningMode(userId: string, signingMode: string) {
    await this.requireEnabled(userId);

    await this.prisma.safeAutomation.update({
      where: { userId },
      data: { signingMode: signingMode as any },
    });

    await this.audit.log({
      userId,
      action: 'SETTINGS_UPDATED',
      details: { signingMode },
    });
  }

  async updateConstraints(userId: string, constraints: SafeConstraints) {
    await this.requireEnabled(userId);

    await this.prisma.safeAutomation.update({
      where: { userId },
      data: { constraints: constraints as any },
    });

    await this.audit.log({
      userId,
      action: 'CONSTRAINTS_UPDATED',
      details: { constraints },
    });
  }

  // ── Session Key Management ───────────────────────────────────────

  async registerSessionKey(userId: string, expiresInSeconds: number, constraints: SafeConstraints) {
    await this.requireEnabled(userId);

    const config = getConfig();

    // Generate a new session key pair
    const wallet = Wallet.createRandom();
    const encryptedPrivateKey = encryptPrivateKey(
      wallet.privateKey,
      config.TRADING_KEY_ENCRYPTION_KEY,
    );

    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);

    // Revoke any currently active session key
    await this.prisma.sessionKey.updateMany({
      where: { userId, status: 'ACTIVE' },
      data: { status: 'ROTATED' },
    });

    const sessionKey = await this.prisma.sessionKey.create({
      data: {
        userId,
        publicAddress: wallet.address,
        encryptedPrivateKey,
        status: 'ACTIVE',
        expiresAt,
      },
    });

    // Update the safe automation record
    await this.prisma.safeAutomation.update({
      where: { userId },
      data: {
        activeSessionKeyId: sessionKey.id,
        sessionKeyPublicAddress: wallet.address,
        constraints: constraints as any,
      },
    });

    await this.audit.log({
      userId,
      action: 'SESSION_KEY_REGISTERED',
      details: {
        sessionKeyId: sessionKey.id,
        publicAddress: wallet.address,
        expiresAt: expiresAt.toISOString(),
      },
    });

    return {
      id: sessionKey.id,
      publicAddress: wallet.address,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async revokeSessionKey(userId: string, sessionKeyId: string) {
    const sk = await this.prisma.sessionKey.findFirst({
      where: { id: sessionKeyId, userId },
    });

    if (!sk) throw new AppError(ErrorCodes.SESSION_KEY_NOT_FOUND, 'Session key not found', 404);
    if (sk.status !== 'ACTIVE') throw new AppError(ErrorCodes.SESSION_KEY_REVOKED, 'Session key already revoked', 400);

    await this.prisma.sessionKey.update({
      where: { id: sessionKeyId },
      data: { status: 'REVOKED' },
    });

    // Clear active session key if this was the active one
    const automation = await this.prisma.safeAutomation.findUnique({
      where: { userId },
    });
    if (automation?.activeSessionKeyId === sessionKeyId) {
      await this.prisma.safeAutomation.update({
        where: { userId },
        data: { activeSessionKeyId: null, sessionKeyPublicAddress: null },
      });
    }

    await this.audit.log({
      userId,
      action: 'SESSION_KEY_REVOKED',
      details: { sessionKeyId, publicAddress: sk.publicAddress },
    });
  }

  async getSessionKeys(userId: string) {
    return this.prisma.sessionKey.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        publicAddress: true,
        status: true,
        expiresAt: true,
        createdAt: true,
      },
    });
  }

  async getActiveSessionKeyWallet(userId: string): Promise<Wallet | null> {
    const automation = await this.prisma.safeAutomation.findUnique({
      where: { userId },
    });

    if (!automation?.activeSessionKeyId) return null;

    const sk = await this.prisma.sessionKey.findUnique({
      where: { id: automation.activeSessionKeyId },
    });

    if (!sk || sk.status !== 'ACTIVE') return null;

    // Check expiry
    if (new Date() > sk.expiresAt) {
      await this.prisma.sessionKey.update({
        where: { id: sk.id },
        data: { status: 'EXPIRED' },
      });
      await this.prisma.safeAutomation.update({
        where: { userId },
        data: { activeSessionKeyId: null, sessionKeyPublicAddress: null },
      });
      return null;
    }

    const config = getConfig();
    const privateKey = decryptPrivateKey(sk.encryptedPrivateKey, config.TRADING_KEY_ENCRYPTION_KEY);
    return new Wallet(privateKey);
  }

  // ── Withdrawal Allowlist ─────────────────────────────────────────

  async getWithdrawalAllowlist(userId: string) {
    return this.prisma.withdrawalAllowlist.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async addWithdrawalAddress(userId: string, address: string, label?: string, txHash?: string) {
    await this.requireEnabled(userId);

    const existing = await this.prisma.withdrawalAllowlist.findUnique({
      where: { userId_address: { userId, address: address.toLowerCase() } },
    });

    if (existing) {
      throw new AppError(ErrorCodes.ALLOWLIST_VIOLATION, 'Address already in allowlist', 409);
    }

    const entry = await this.prisma.withdrawalAllowlist.create({
      data: {
        userId,
        address: address.toLowerCase(),
        label,
        addedTxHash: txHash,
      },
    });

    await this.audit.log({
      userId,
      action: 'WITHDRAWAL_ALLOWLIST_ADDED',
      details: { address: address.toLowerCase(), label },
    });

    return entry;
  }

  async removeWithdrawalAddress(userId: string, address: string) {
    const entry = await this.prisma.withdrawalAllowlist.findUnique({
      where: { userId_address: { userId, address: address.toLowerCase() } },
    });

    if (!entry) {
      throw new AppError(ErrorCodes.NOT_FOUND, 'Address not in allowlist', 404);
    }

    await this.prisma.withdrawalAllowlist.delete({
      where: { id: entry.id },
    });

    await this.audit.log({
      userId,
      action: 'WITHDRAWAL_ALLOWLIST_REMOVED',
      details: { address: address.toLowerCase() },
    });
  }

  // ── Module Transaction Tracking ──────────────────────────────────

  async recordModuleTx(params: {
    userId: string;
    sessionKeyId?: string;
    action: string;
    targetContract: string;
    functionSelector: string;
    callData: string;
    notionalUsd?: number;
  }) {
    return this.prisma.moduleTx.create({
      data: {
        userId: params.userId,
        sessionKeyId: params.sessionKeyId,
        action: params.action,
        targetContract: params.targetContract,
        functionSelector: params.functionSelector,
        callData: params.callData,
        notionalUsd: params.notionalUsd,
        status: 'PENDING',
      },
    });
  }

  async updateModuleTxStatus(
    txId: string,
    status: 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'BLOCKED',
    details?: { transactionHash?: string; errorMessage?: string; blockReason?: string },
  ) {
    await this.prisma.moduleTx.update({
      where: { id: txId },
      data: {
        status,
        transactionHash: details?.transactionHash,
        errorMessage: details?.errorMessage,
        blockReason: details?.blockReason,
      },
    });
  }

  async getModuleTxs(userId: string, limit = 50) {
    return this.prisma.moduleTx.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private async requireEnabled(userId: string) {
    const automation = await this.prisma.safeAutomation.findUnique({
      where: { userId },
    });

    if (!automation || !automation.enabled) {
      throw new AppError(ErrorCodes.MODULE_NOT_ENABLED, 'Safe automation module is not enabled', 400);
    }

    return automation;
  }
}
