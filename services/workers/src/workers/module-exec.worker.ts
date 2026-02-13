import { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { Wallet, JsonRpcProvider, Contract, parseUnits } from 'ethers';
import { decryptPrivateKey, POLYMARKET_CONTRACTS } from '@mirrormarkets/shared';

// ABI for executeFromSessionKey
const MODULE_ABI = [
  'function executeFromSessionKey(address safe, address to, uint256 value, bytes calldata data, uint256 notionalUsd) external',
];

/**
 * ModuleExecWorker — Phase 2B
 *
 * Processes pending module transactions (ModuleTx records with status=PENDING).
 * Uses the user's active session key to call AutomationModule.executeFromSessionKey()
 * which enforces onchain constraints before executing through the Safe.
 *
 * Polling interval: 10 seconds (high urgency for copy trades).
 */
export class ModuleExecWorker {
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly pollMs = 10_000;

  constructor(
    private prisma: PrismaClient,
    private redis: Redis,
    private logger: Logger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.logger.info({ pollMs: this.pollMs }, 'Module exec worker started');
    this.interval = setInterval(() => this.poll(), this.pollMs);
  }

  stop(): void {
    this.running = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.logger.info('Module exec worker stopped');
  }

  private async poll(): Promise<void> {
    try {
      await this.redis.set('worker:module-exec:last-ping', Date.now().toString());

      // Find pending module transactions
      const pendingTxs = await this.prisma.moduleTx.findMany({
        where: { status: 'PENDING' },
        take: 10,
        orderBy: { createdAt: 'asc' },
        include: {
          user: {
            include: {
              safeAutomation: true,
              sessionKeys: {
                where: { status: 'ACTIVE' },
                take: 1,
              },
            },
          },
        },
      });

      for (const tx of pendingTxs) {
        try {
          await this.processModuleTx(tx);
        } catch (error) {
          this.logger.error(
            { txId: tx.id, userId: tx.userId, err: error },
            'Module tx execution failed',
          );

          await this.prisma.moduleTx.update({
            where: { id: tx.id },
            data: {
              status: 'FAILED',
              errorMessage: error instanceof Error ? error.message : 'Unknown error',
            },
          });
        }
      }
    } catch (error) {
      this.logger.error({ err: error }, 'Module exec poll error');
    }
  }

  private async processModuleTx(tx: any): Promise<void> {
    const automation = tx.user?.safeAutomation;
    if (!automation || !automation.enabled) {
      await this.prisma.moduleTx.update({
        where: { id: tx.id },
        data: { status: 'BLOCKED', blockReason: 'Module not enabled' },
      });
      return;
    }

    const activeSessionKey = tx.user?.sessionKeys?.[0];
    if (!activeSessionKey) {
      await this.prisma.moduleTx.update({
        where: { id: tx.id },
        data: { status: 'BLOCKED', blockReason: 'No active session key' },
      });
      return;
    }

    // Check session key expiry
    if (new Date() > activeSessionKey.expiresAt) {
      await this.prisma.sessionKey.update({
        where: { id: activeSessionKey.id },
        data: { status: 'EXPIRED' },
      });
      await this.prisma.moduleTx.update({
        where: { id: tx.id },
        data: { status: 'BLOCKED', blockReason: 'Session key expired' },
      });
      return;
    }

    // Decrypt session key
    const encryptionKey = process.env.TRADING_KEY_ENCRYPTION_KEY;
    if (!encryptionKey) {
      await this.prisma.moduleTx.update({
        where: { id: tx.id },
        data: { status: 'FAILED', errorMessage: 'Encryption key not configured' },
      });
      return;
    }

    let sessionKeyWallet: Wallet;
    try {
      const privateKey = decryptPrivateKey(activeSessionKey.encryptedPrivateKey, encryptionKey);
      const rpcUrl = process.env.POLYGON_RPC_URL ?? 'https://polygon-rpc.com';
      const provider = new JsonRpcProvider(rpcUrl);
      sessionKeyWallet = new Wallet(privateKey, provider);
    } catch (error) {
      await this.prisma.moduleTx.update({
        where: { id: tx.id },
        data: { status: 'FAILED', errorMessage: 'Failed to decrypt session key' },
      });
      return;
    }

    // Mark as submitted
    await this.prisma.moduleTx.update({
      where: { id: tx.id },
      data: { status: 'SUBMITTED' },
    });

    // Build module call
    const moduleContract = new Contract(
      automation.moduleAddress,
      MODULE_ABI,
      sessionKeyWallet,
    );

    try {
      const txResponse = await moduleContract.executeFromSessionKey(
        automation.safeAddress,
        tx.targetContract,
        0, // value (no ETH)
        tx.callData,
        parseUnits(String(tx.notionalUsd ?? 0), 6), // notional in USDC decimals
      );

      const receipt = await txResponse.wait();

      await this.prisma.moduleTx.update({
        where: { id: tx.id },
        data: {
          status: 'CONFIRMED',
          transactionHash: receipt.hash,
        },
      });

      await this.prisma.auditLog.create({
        data: {
          userId: tx.userId,
          action: 'MODULE_TX_CONFIRMED',
          details: {
            txId: tx.id,
            action: tx.action,
            transactionHash: receipt.hash,
          },
        },
      });

      this.logger.info(
        { txId: tx.id, hash: receipt.hash, action: tx.action },
        'Module tx confirmed',
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown';

      // Check if this is a constraint violation (revert reason from the module)
      const isConstraintViolation = errorMsg.includes('AutomationModule:');
      const status = isConstraintViolation ? 'BLOCKED' : 'FAILED';

      await this.prisma.moduleTx.update({
        where: { id: tx.id },
        data: {
          status,
          errorMessage: errorMsg,
          blockReason: isConstraintViolation ? errorMsg : undefined,
        },
      });

      const auditAction = isConstraintViolation ? 'MODULE_TX_BLOCKED' : 'MODULE_TX_SUBMITTED';
      await this.prisma.auditLog.create({
        data: {
          userId: tx.userId,
          action: auditAction,
          details: { txId: tx.id, error: errorMsg },
        },
      });
    }
  }
}
