import { FastifyPluginAsync } from 'fastify';
import { redeemSchema, updateAutoClaimSchema, AppError, ErrorCodes } from '@mirrormarkets/shared';
import { WalletService } from '../services/wallet.service.js';
import { PortfolioService } from '../services/portfolio.service.js';
import { AuditService } from '../services/audit.service.js';
import { getTradingAuthorityProvider } from '../adapters/trading-authority.factory.js';

export const claimRoutes: FastifyPluginAsync = async (app) => {
  const tradingAuthority = getTradingAuthorityProvider(app.prisma);
  const walletService = new WalletService(app.prisma, tradingAuthority);
  const portfolio = new PortfolioService(app.prisma);
  const audit = new AuditService(app.prisma);

  // GET /claims/claimable
  app.get('/claimable', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const claimable = await portfolio.getClaimable(request.userId);
    return reply.send(claimable);
  });

  // POST /claims/redeem
  app.post('/redeem', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { conditionId } = redeemSchema.parse(request.body);

    const relayer = await walletService.getRelayerAdapter(request.userId);
    const txHash = await relayer.redeemPositions(conditionId);

    await audit.log({
      userId: request.userId,
      action: 'CLAIM_REDEEMED',
      details: { conditionId, txHash },
      ipAddress: request.ip,
    });

    await app.prisma.relayerTx.create({
      data: {
        userId: request.userId,
        type: 'REDEEM',
        status: 'SUBMITTED',
        transactionHash: txHash,
      },
    });

    return reply.send({ transactionHash: txHash });
  });

  // PUT /claims/auto-claim
  app.put('/auto-claim', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { enabled, minClaimableUsd } = updateAutoClaimSchema.parse(request.body);

    const settings = await app.prisma.autoClaimSettings.upsert({
      where: { userId: request.userId },
      create: {
        userId: request.userId,
        enabled,
        minClaimableUsd: minClaimableUsd ?? 1,
      },
      update: {
        enabled,
        ...(minClaimableUsd !== undefined && { minClaimableUsd }),
      },
    });

    await audit.log({
      userId: request.userId,
      action: enabled ? 'AUTO_CLAIM_ENABLED' : 'AUTO_CLAIM_DISABLED',
      details: { minClaimableUsd },
      ipAddress: request.ip,
    });

    return reply.send(settings);
  });

  // GET /claims/auto-claim
  app.get('/auto-claim', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const settings = await app.prisma.autoClaimSettings.findUnique({
      where: { userId: request.userId },
    });

    return reply.send(settings ?? { enabled: false, minClaimableUsd: 1 });
  });
};
