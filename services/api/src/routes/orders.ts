import { FastifyPluginAsync } from 'fastify';
import { createOrderSchema, cancelOrderSchema, paginationSchema, NotFoundError } from '@mirrormarkets/shared';
import { WalletService } from '../services/wallet.service.js';
import { AuditService } from '../services/audit.service.js';
import { getTradingAuthorityProvider } from '../adapters/trading-authority.factory.js';

export const orderRoutes: FastifyPluginAsync = async (app) => {
  const tradingAuthority = getTradingAuthorityProvider(app.prisma);
  const walletService = new WalletService(app.prisma, tradingAuthority);
  const audit = new AuditService(app.prisma);

  // POST /orders
  app.post('/', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { tokenId, side, size, price } = createOrderSchema.parse(request.body);

    const adapter = await walletService.getPolymarketAdapter(request.userId);
    const result = await adapter.createOrder({ tokenId, side, size, price });

    const order = await app.prisma.order.create({
      data: {
        userId: request.userId,
        polyOrderId: result.orderID ?? result.id,
        conditionId: result.asset_id ?? tokenId,
        tokenId,
        side,
        size,
        price,
        status: 'OPEN',
      },
    });

    await audit.log({
      userId: request.userId,
      action: 'ORDER_PLACED',
      details: { orderId: order.id, tokenId, side, size, price },
      ipAddress: request.ip,
    });

    return reply.status(201).send(order);
  });

  // GET /orders
  app.get('/', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { page, pageSize } = paginationSchema.parse(request.query);

    const [items, total] = await Promise.all([
      app.prisma.order.findMany({
        where: { userId: request.userId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      app.prisma.order.count({ where: { userId: request.userId } }),
    ]);

    return reply.send({
      items,
      total,
      page,
      pageSize,
      hasMore: page * pageSize < total,
    });
  });

  // POST /orders/:orderId/cancel
  app.post('/:orderId/cancel', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { orderId } = request.params as { orderId: string };

    const order = await app.prisma.order.findFirst({
      where: { id: orderId, userId: request.userId },
    });

    if (!order) throw new NotFoundError('Order');

    const adapter = await walletService.getPolymarketAdapter(request.userId);

    if (order.polyOrderId) {
      await adapter.cancelOrder(order.polyOrderId);
    }

    await app.prisma.order.update({
      where: { id: orderId },
      data: { status: 'CANCELLED' },
    });

    await audit.log({
      userId: request.userId,
      action: 'ORDER_CANCELLED',
      details: { orderId },
      ipAddress: request.ip,
    });

    return reply.send({ ok: true });
  });
};
