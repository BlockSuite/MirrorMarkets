import { FastifyPluginAsync } from 'fastify';
import { searchUsersSchema } from '@mirrormarkets/shared';
import { PolymarketAdapter } from '../adapters/polymarket.adapter.js';

export const userRoutes: FastifyPluginAsync = async (app) => {
  // GET /users/search?query=...
  app.get('/search', async (request, reply) => {
    const { query } = searchUsersSchema.parse(request.query);

    const results = await PolymarketAdapter.searchUsers(query);

    return reply.send(results);
  });
};
