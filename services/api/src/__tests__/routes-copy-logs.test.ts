import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { AppError, ErrorCodes } from '@mirrormarkets/shared';

// ── Mock data ────────────────────────────────────────────────────────────────

const MOCK_LEADER_EVENT = {
  id: 'event-1',
  leaderId: 'leader-1',
  conditionId: '0xcond1',
  tokenId: '0xtok1',
  marketSlug: 'will-btc-hit-100k',
  side: 'BUY',
  size: 500,
  price: 0.65,
  detectedAt: new Date('2025-01-15'),
  createdAt: new Date('2025-01-15'),
};

const MOCK_COPY_ATTEMPT = {
  id: 'attempt-1',
  userId: 'user-1',
  leaderEventId: 'event-1',
  status: 'FILLED',
  orderId: 'order-1',
  skipReason: null,
  errorMessage: null,
  createdAt: new Date('2025-01-15'),
  updatedAt: new Date('2025-01-15'),
  leaderEvent: MOCK_LEADER_EVENT,
  order: { id: 'order-1' },
};

const MOCK_COPY_ATTEMPT_2 = {
  id: 'attempt-2',
  userId: 'user-1',
  leaderEventId: 'event-2',
  status: 'SKIPPED',
  orderId: null,
  skipReason: 'Max positions reached',
  errorMessage: null,
  createdAt: new Date('2025-01-14'),
  updatedAt: new Date('2025-01-14'),
  leaderEvent: {
    ...MOCK_LEADER_EVENT,
    id: 'event-2',
    leaderId: 'leader-2',
    side: 'SELL',
  },
  order: null,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockPrisma() {
  return {
    copyProfile: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    copyAttempt: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
    authSession: {
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
  };
}

async function buildApp(mockPrisma: ReturnType<typeof createMockPrisma>) {
  const app = Fastify({ logger: false });

  await app.register(
    fp(async (fastify) => {
      fastify.decorate('prisma', mockPrisma);
    }, { name: 'prisma' }),
  );

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
            details: { issues: error.issues },
          });
        }
        return reply.status(500).send({
          code: ErrorCodes.INTERNAL_ERROR,
          message: 'Internal server error',
        });
      });
    }, { name: 'error-handler' }),
  );

  await app.register(
    fp(async (fastify) => {
      fastify.decorateRequest('userId', '');
      fastify.decorateRequest('sessionId', '');
      fastify.decorate('authenticate', async (request: any) => {
        const authHeader = request.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
          throw new AppError(ErrorCodes.UNAUTHORIZED, 'Unauthorized', 401);
        }
        const token = authHeader.slice(7);
        const session = await mockPrisma.authSession.findUnique({
          where: { token },
          select: { id: true, userId: true, expiresAt: true },
        });
        if (!session) {
          throw new AppError(ErrorCodes.UNAUTHORIZED, 'Invalid session token', 401);
        }
        request.userId = session.userId;
        request.sessionId = session.id;
      });
    }, { name: 'auth' }),
  );

  const { copyRoutes } = await import('../routes/copy.js');
  await app.register(copyRoutes, { prefix: '/copy' });

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

const AUTH = { authorization: 'Bearer valid-token' };

// ── Tests: GET /copy/logs ────────────────────────────────────────────────────

describe('GET /copy/logs', () => {
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

  it('returns 401 without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/copy/logs' });
    expect(res.statusCode).toBe(401);
  });

  it('returns paginated copy attempts', async () => {
    mockAuthSession(mockPrisma);
    mockPrisma.copyAttempt.findMany.mockResolvedValue([MOCK_COPY_ATTEMPT, MOCK_COPY_ATTEMPT_2]);
    mockPrisma.copyAttempt.count.mockResolvedValue(2);

    const res = await app.inject({
      method: 'GET',
      url: '/copy/logs?page=1',
      headers: AUTH,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(2);
    expect(body.total).toBe(2);
    expect(body.page).toBe(1);
    expect(body.hasMore).toBe(false);
  });

  it('filters by userId', async () => {
    mockAuthSession(mockPrisma);
    mockPrisma.copyAttempt.findMany.mockResolvedValue([]);
    mockPrisma.copyAttempt.count.mockResolvedValue(0);

    await app.inject({
      method: 'GET',
      url: '/copy/logs',
      headers: AUTH,
    });

    expect(mockPrisma.copyAttempt.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1' },
      }),
    );
  });

  it('filters by leaderId when provided', async () => {
    mockAuthSession(mockPrisma);
    mockPrisma.copyAttempt.findMany.mockResolvedValue([MOCK_COPY_ATTEMPT]);
    mockPrisma.copyAttempt.count.mockResolvedValue(1);

    const res = await app.inject({
      method: 'GET',
      url: '/copy/logs?leaderId=leader-1',
      headers: AUTH,
    });

    expect(res.statusCode).toBe(200);

    expect(mockPrisma.copyAttempt.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: 'user-1',
          leaderEvent: { leaderId: 'leader-1' },
        },
      }),
    );
  });

  it('count uses same where clause with leaderId filter', async () => {
    mockAuthSession(mockPrisma);
    mockPrisma.copyAttempt.findMany.mockResolvedValue([]);
    mockPrisma.copyAttempt.count.mockResolvedValue(0);

    await app.inject({
      method: 'GET',
      url: '/copy/logs?leaderId=leader-1',
      headers: AUTH,
    });

    expect(mockPrisma.copyAttempt.count).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        leaderEvent: { leaderId: 'leader-1' },
      },
    });
  });

  it('does not add leaderEvent filter when leaderId is absent', async () => {
    mockAuthSession(mockPrisma);
    mockPrisma.copyAttempt.findMany.mockResolvedValue([]);
    mockPrisma.copyAttempt.count.mockResolvedValue(0);

    await app.inject({
      method: 'GET',
      url: '/copy/logs',
      headers: AUTH,
    });

    expect(mockPrisma.copyAttempt.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1' },
      }),
    );
    // Make sure leaderEvent key is NOT in the where clause
    const whereArg = mockPrisma.copyAttempt.findMany.mock.calls[0][0].where;
    expect(whereArg).not.toHaveProperty('leaderEvent');
  });

  it('includes leaderEvent and order relations', async () => {
    mockAuthSession(mockPrisma);
    mockPrisma.copyAttempt.findMany.mockResolvedValue([]);
    mockPrisma.copyAttempt.count.mockResolvedValue(0);

    await app.inject({
      method: 'GET',
      url: '/copy/logs',
      headers: AUTH,
    });

    expect(mockPrisma.copyAttempt.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: { leaderEvent: true, order: true },
        orderBy: { createdAt: 'desc' },
      }),
    );
  });

  it('reports hasMore when more items exist beyond current page', async () => {
    mockAuthSession(mockPrisma);
    mockPrisma.copyAttempt.findMany.mockResolvedValue([MOCK_COPY_ATTEMPT]);
    mockPrisma.copyAttempt.count.mockResolvedValue(15);

    const res = await app.inject({
      method: 'GET',
      url: '/copy/logs?page=1&pageSize=10',
      headers: AUTH,
    });

    const body = res.json();
    expect(body.hasMore).toBe(true);
  });

  it('returns hasMore=false on last page', async () => {
    mockAuthSession(mockPrisma);
    mockPrisma.copyAttempt.findMany.mockResolvedValue([MOCK_COPY_ATTEMPT]);
    mockPrisma.copyAttempt.count.mockResolvedValue(1);

    const res = await app.inject({
      method: 'GET',
      url: '/copy/logs?page=1&pageSize=10',
      headers: AUTH,
    });

    const body = res.json();
    expect(body.hasMore).toBe(false);
  });

  it('returns empty items when no copy attempts exist', async () => {
    mockAuthSession(mockPrisma);
    mockPrisma.copyAttempt.findMany.mockResolvedValue([]);
    mockPrisma.copyAttempt.count.mockResolvedValue(0);

    const res = await app.inject({
      method: 'GET',
      url: '/copy/logs',
      headers: AUTH,
    });

    const body = res.json();
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });
});
