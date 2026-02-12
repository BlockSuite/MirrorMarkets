import { FastifyPluginAsync } from 'fastify';
import { PolymarketAdapter } from '../adapters/polymarket.adapter.js';

export const leaderRoutes: FastifyPluginAsync = async (app) => {
  // GET /leaders/leaderboard
  app.get('/leaderboard', async (request, reply) => {
    const leaders = await PolymarketAdapter.fetchLeaderboard();

    // Sync leaders to local DB
    for (const leader of leaders) {
      await app.prisma.leader.upsert({
        where: { address: leader.address },
        create: {
          address: leader.address,
          displayName: leader.displayName,
          profileImageUrl: leader.profileImageUrl,
          pnl: leader.pnl,
          volume: leader.volume,
          rank: leader.rank,
          lastSyncedAt: new Date(),
        },
        update: {
          displayName: leader.displayName,
          profileImageUrl: leader.profileImageUrl,
          pnl: leader.pnl,
          volume: leader.volume,
          rank: leader.rank,
          lastSyncedAt: new Date(),
        },
      });
    }

    const dbLeaders = await app.prisma.leader.findMany({
      orderBy: { rank: 'asc' },
      take: 50,
    });

    return reply.send(dbLeaders);
  });
};
