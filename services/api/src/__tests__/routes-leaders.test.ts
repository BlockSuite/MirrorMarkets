import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { AppError, ErrorCodes } from '@mirrormarkets/shared';

// ── Mock Prisma data ─────────────────────────────────────────────────────────

const MOCK_LEADER = {
  id: 'leader-1',
  address: '0xabc123',
  displayName: 'TestLeader',
  profileImageUrl: 'https://img.example.com/pic.jpg',
  pnl: 50000,
  volume: 200000,
  rank: 1,
  lastSyncedAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
};

const MOCK_LEADER_2 = {
  id: 'leader-2',
  address: '0xdef456',
  displayName: 'TestLeader2',
  profileImageUrl: null,
  pnl: -5000,
  volume: 100000,
  rank: 2,
  lastSyncedAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
};

const MOCK_EVENTS = [
  {
    id: 'event-1',
    leaderId: 'leader-1',
    conditionId: '0xcond1',
    tokenId: '0xtok1',
    marketSlug: 'will-btc-hit-100k',
    side: 'BUY',
    size: 500,
    price: 0.65,
    transactionHash: '0xtx1',
    detectedAt: new Date('2025-01-15'),
    createdAt: new Date('2025-01-15'),
  },
  {
    id: 'event-2',
    leaderId: 'leader-1',
    conditionId: '0xcond2',
    tokenId: '0xtok2',
    marketSlug: null,
    side: 'SELL',
    size: 200,
    price: 0.30,
    transactionHash: null,
    detectedAt: new Date('2025-01-14'),
    createdAt: new Date('2025-01-14'),
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockPrisma() {
  return {
    leader: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
    leaderEvent: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    authSession: {
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
  };
}

async function buildApp(mockPrisma: ReturnType<typeof createMockPrisma>) {
  const app = Fastify({ logger: false });

  // Register prisma mock as plugin
  await app.register(
    fp(async (fastify) => {
      fastify.decorate('prisma', mockPrisma);
    }, { name: 'prisma' }),
  );

  // Error handler
  await app.register(
    fp(async (fastify) => {
      fastify.setErrorHandler((error: any, _request, reply) => {
        if (error instanceof AppError) {
          return reply.status(error.statusCode).send(error.toJSON());
        }
        if (error?.name === 'ZodError' && Array.isArray(error?.issues)) {
          return reply.status(400).send({
            code: ErrorCodes.VALIDATION_ERROR,
            message: 'Validation failed',
          });
        }
        return reply.status(500).send({
          code: ErrorCodes.INTERNAL_ERROR,
          message: 'Internal server error',
        });
      });
    }, { name: 'error-handler' }),
  );

  // Auth mock
  await app.register(
    fp(async (fastify) => {
      fastify.decorateRequest('userId', '');
      fastify.decorateRequest('sessionId', '');
      fastify.decorate('authenticate', async (request: any) => {
        const authHeader = request.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
          throw new AppError(ErrorCodes.UNAUTHORIZED, 'Missing or invalid authorization header', 401);
        }
        const token = authHeader.slice(7);
        const session = await mockPrisma.authSession.findUnique({
          where: { token },
          select: { id: true, userId: true, expiresAt: true },
        });
        if (!session) {
          throw new AppError(ErrorCodes.UNAUTHORIZED, 'Invalid session token', 401);
        }
        if (session.expiresAt < new Date()) {
          throw new AppError(ErrorCodes.UNAUTHORIZED, 'Session expired', 401);
        }
        request.userId = session.userId;
        request.sessionId = session.id;
      });
    }, { name: 'auth' }),
  );

  // Mock the PolymarketAdapter before importing leaders routes
  vi.mock('../adapters/polymarket.adapter.js', () => ({
    PolymarketAdapter: {
      fetchLeaderboard: vi.fn().mockResolvedValue([]),
    },
  }));

  const { leaderRoutes } = await import('../routes/leaders.js');
  await app.register(leaderRoutes, { prefix: '/leaders' });

  await app.ready();
  return app;
}

function mockAuthSession(mockPrisma: ReturnType<typeof createMockPrisma>, userId = 'user-1') {
  mockPrisma.authSession.findUnique.mockResolvedValue({
    id: 'session-1',
    userId,
    expiresAt: new Date(Date.now() + 3600_000),
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('GET /leaders/:leaderId', () => {
  let app: FastifyInstance;
  let mockPrisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    mockPrisma = createMockPrisma();
    app = await buildApp(mockPrisma);
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  it('returns 401 without auth token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/leaders/leader-1',
    });

    expect(res.statusCode).toBe(401);
  });

  it('returns 401 with invalid token', async () => {
    mockPrisma.authSession.findUnique.mockResolvedValue(null);

    const res = await app.inject({
      method: 'GET',
      url: '/leaders/leader-1',
      headers: { authorization: 'Bearer invalid-token' },
    });

    expect(res.statusCode).toBe(401);
  });

  it('returns leader by ID', async () => {
    mockAuthSession(mockPrisma);
    mockPrisma.leader.findUnique.mockResolvedValue(MOCK_LEADER);

    const res = await app.inject({
      method: 'GET',
      url: '/leaders/leader-1',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe('leader-1');
    expect(body.displayName).toBe('TestLeader');
    expect(body.pnl).toBe(50000);
    expect(body.volume).toBe(200000);
    expect(body.rank).toBe(1);
  });

  it('returns 404 for non-existent leader', async () => {
    mockAuthSession(mockPrisma);
    mockPrisma.leader.findUnique.mockResolvedValue(null);

    const res = await app.inject({
      method: 'GET',
      url: '/leaders/nonexistent',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.code).toBe('NOT_FOUND');
  });

  it('queries prisma with the correct leaderId', async () => {
    mockAuthSession(mockPrisma);
    mockPrisma.leader.findUnique.mockResolvedValue(MOCK_LEADER);

    await app.inject({
      method: 'GET',
      url: '/leaders/leader-1',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(mockPrisma.leader.findUnique).toHaveBeenCalledWith({
      where: { id: 'leader-1' },
    });
  });
});

describe('GET /leaders/:leaderId/events', () => {
  let app: FastifyInstance;
  let mockPrisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    mockPrisma = createMockPrisma();
    app = await buildApp(mockPrisma);
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  it('returns 401 without auth token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/leaders/leader-1/events',
    });

    expect(res.statusCode).toBe(401);
  });

  it('returns 404 for non-existent leader', async () => {
    mockAuthSession(mockPrisma);
    mockPrisma.leader.findUnique.mockResolvedValue(null);

    const res = await app.inject({
      method: 'GET',
      url: '/leaders/leader-1/events',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns paginated events for a leader', async () => {
    mockAuthSession(mockPrisma);
    mockPrisma.leader.findUnique.mockResolvedValue(MOCK_LEADER);
    mockPrisma.leaderEvent.findMany.mockResolvedValue(MOCK_EVENTS);
    mockPrisma.leaderEvent.count.mockResolvedValue(2);

    const res = await app.inject({
      method: 'GET',
      url: '/leaders/leader-1/events?page=1&pageSize=10',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(2);
    expect(body.total).toBe(2);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(10);
    expect(body.hasMore).toBe(false);
  });

  it('reports hasMore correctly when there are more pages', async () => {
    mockAuthSession(mockPrisma);
    mockPrisma.leader.findUnique.mockResolvedValue(MOCK_LEADER);
    mockPrisma.leaderEvent.findMany.mockResolvedValue(MOCK_EVENTS);
    mockPrisma.leaderEvent.count.mockResolvedValue(25);

    const res = await app.inject({
      method: 'GET',
      url: '/leaders/leader-1/events?page=1&pageSize=10',
      headers: { authorization: 'Bearer valid-token' },
    });

    const body = res.json();
    expect(body.hasMore).toBe(true);
    expect(body.total).toBe(25);
  });

  it('uses correct skip/take for page 2', async () => {
    mockAuthSession(mockPrisma);
    mockPrisma.leader.findUnique.mockResolvedValue(MOCK_LEADER);
    mockPrisma.leaderEvent.findMany.mockResolvedValue([]);
    mockPrisma.leaderEvent.count.mockResolvedValue(0);

    await app.inject({
      method: 'GET',
      url: '/leaders/leader-1/events?page=2&pageSize=5',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(mockPrisma.leaderEvent.findMany).toHaveBeenCalledWith({
      where: { leaderId: 'leader-1' },
      orderBy: { detectedAt: 'desc' },
      skip: 5,
      take: 5,
    });
  });

  it('defaults to page=1, pageSize=20 when no query params', async () => {
    mockAuthSession(mockPrisma);
    mockPrisma.leader.findUnique.mockResolvedValue(MOCK_LEADER);
    mockPrisma.leaderEvent.findMany.mockResolvedValue([]);
    mockPrisma.leaderEvent.count.mockResolvedValue(0);

    await app.inject({
      method: 'GET',
      url: '/leaders/leader-1/events',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(mockPrisma.leaderEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 0,
        take: 20,
      }),
    );
  });

  it('returns empty items when no events exist', async () => {
    mockAuthSession(mockPrisma);
    mockPrisma.leader.findUnique.mockResolvedValue(MOCK_LEADER);
    mockPrisma.leaderEvent.findMany.mockResolvedValue([]);
    mockPrisma.leaderEvent.count.mockResolvedValue(0);

    const res = await app.inject({
      method: 'GET',
      url: '/leaders/leader-1/events',
      headers: { authorization: 'Bearer valid-token' },
    });

    const body = res.json();
    expect(body.items).toHaveLength(0);
    expect(body.total).toBe(0);
    expect(body.hasMore).toBe(false);
  });
});
