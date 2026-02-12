import { FastifyPluginAsync } from 'fastify';
import { ProvisioningService } from '../services/provisioning.service.js';
import { AuditService } from '../services/audit.service.js';
import { getTradingAuthorityProvider } from '../adapters/trading-authority.factory.js';

export const walletRoutes: FastifyPluginAsync = async (app) => {
  const audit = new AuditService(app.prisma);
  const tradingAuthority = getTradingAuthorityProvider(app.prisma);
  const provisioning = new ProvisioningService(app.prisma, audit, tradingAuthority);

  // POST /wallets/provision
  app.post('/provision', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { dynamicEoaAddress } = request.body as { dynamicEoaAddress: string };

    const status = await provisioning.provision(
      request.userId,
      dynamicEoaAddress,
      request.ip,
    );

    return reply.send(status);
  });

  // GET /me
  app.get('/me', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const user = await app.prisma.user.findUnique({
      where: { id: request.userId },
      select: {
        id: true,
        email: true,
        name: true,
        avatarUrl: true,
        createdAt: true,
      },
    });

    return reply.send(user);
  });

  // GET /me/wallets
  app.get('/me/wallets', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const wallets = await app.prisma.wallet.findMany({
      where: { userId: request.userId },
      select: { type: true, address: true },
    });

    return reply.send(wallets);
  });

  // GET /me/provisioning-status
  app.get('/me/provisioning-status', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const status = await provisioning.getStatus(request.userId);
    return reply.send(status);
  });
};
