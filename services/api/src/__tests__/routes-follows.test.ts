import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { AppError, ErrorCodes } from '@mirrormarkets/shared';

// ── Mock data ────────────────────────────────────────────────────────────────

const VALID_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';
const VALID_ADDRESS_2 = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';

const MOCK_LEADER = {
  id: 'leader-1',
  address: VALID_ADDRESS,
  displayName: 'TestLeader',
  profileImageUrl: null,
  pnl: 50000,
  volume: 200000,
  rank: 1,
  lastSyncedAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
};

const MOCK_FOLLOW = {
  id: 'follow-1',
  userId: 'user-1',
  leaderId: 'leader-1',
  status: 'ACTIVE',
  createdAt: new Date(),
  updatedAt: new Date(),
  leader: MOCK_LEADER,
};

const MOCK_FOLLOW_2 = {
  id: 'follow-2',
  userId: 'user-1',
  leaderId: 'leader-2',
  status: 'ACTIVE',
  createdAt: new Date(),
  updatedAt: new Date(),
  leader: {
    ...MOCK_LEADER,
    id: 'leader-2',
    address: VALID_ADDRESS_2,
    displayName: 'Leader2',
    rank: 2,
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockPrisma() {
  return {
    leader: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    follow: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
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

  const { followRoutes } = await import('../routes/follows.js');
  await app.register(followRoutes, { prefix: '/follows' });

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

// ── Tests: GET /follows ──────────────────────────────────────────────────────

describe('GET /follows', () => {
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
    const res = await app.inject({ method: 'GET', url: '/follows' });
    expect(res.statusCode).toBe(401);
  });

  it('returns list of active follows with leader details', async () => {
    mockAuthSession(mockPrisma);
    mockPrisma.follow.findMany.mockResolvedValue([MOCK_FOLLOW, MOCK_FOLLOW_2]);

    const res = await app.inject({ method: 'GET', url: '/follows', headers: AUTH });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(2);
    expect(body[0].id).toBe('follow-1');
    expect(body[0].leader.displayName).toBe('TestLeader');
    expect(body[1].leader.displayName).toBe('Leader2');
  });

  it('filters by userId and ACTIVE status', async () => {
    mockAuthSession(mockPrisma);
    mockPrisma.follow.findMany.mockResolvedValue([]);

    await app.inject({ method: 'GET', url: '/follows', headers: AUTH });

    expect(mockPrisma.follow.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', status: 'ACTIVE' },
      include: { leader: true },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('returns empty array when user has no follows', async () => {
    mockAuthSession(mockPrisma);
    mockPrisma.follow.findMany.mockResolvedValue([]);

    const res = await app.inject({ method: 'GET', url: '/follows', headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});

// ── Tests: POST /follows ─────────────────────────────────────────────────────

describe('POST /follows', () => {
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
    const res = await app.inject({
      method: 'POST',
      url: '/follows',
      payload: { leaderAddress: '0xabc' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('creates a follow for an existing leader', async () => {
    mockAuthSession(mockPrisma);
    mockPrisma.leader.findUnique.mockResolvedValue(MOCK_LEADER);
    mockPrisma.follow.findUnique.mockResolvedValue(null);
    mockPrisma.follow.upsert.mockResolvedValue(MOCK_FOLLOW);
    mockPrisma.auditLog.create.mockResolvedValue({});

    const res = await app.inject({
      method: 'POST',
      url: '/follows',
      headers: AUTH,
      payload: { leaderAddress: VALID_ADDRESS },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBe('follow-1');
    expect(body.status).toBe('ACTIVE');
  });

  it('normalizes leader address to lowercase', async () => {
    mockAuthSession(mockPrisma);
    mockPrisma.leader.findUnique.mockResolvedValue(MOCK_LEADER);
    mockPrisma.follow.findUnique.mockResolvedValue(null);
    mockPrisma.follow.upsert.mockResolvedValue(MOCK_FOLLOW);
    mockPrisma.auditLog.create.mockResolvedValue({});

    await app.inject({
      method: 'POST',
      url: '/follows',
      headers: AUTH,
      payload: { leaderAddress: '0x1234567890ABCDEF1234567890ABCDEF12345678' },
    });

    expect(mockPrisma.leader.findUnique).toHaveBeenCalledWith({
      where: { address: '0x1234567890abcdef1234567890abcdef12345678' },
    });
  });

  it('creates a new leader record if leader does not exist', async () => {
    mockAuthSession(mockPrisma);
    mockPrisma.leader.findUnique.mockResolvedValue(null);
    mockPrisma.leader.create.mockResolvedValue({ ...MOCK_LEADER, id: 'new-leader' });
    mockPrisma.follow.findUnique.mockResolvedValue(null);
    mockPrisma.follow.upsert.mockResolvedValue({ ...MOCK_FOLLOW, leaderId: 'new-leader' });
    mockPrisma.auditLog.create.mockResolvedValue({});

    const res = await app.inject({
      method: 'POST',
      url: '/follows',
      headers: AUTH,
      payload: { leaderAddress: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
    });

    expect(res.statusCode).toBe(201);
    expect(mockPrisma.leader.create).toHaveBeenCalledWith({
      data: { address: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
    });
  });

  it('returns 409 when already following this leader', async () => {
    mockAuthSession(mockPrisma);
    mockPrisma.leader.findUnique.mockResolvedValue(MOCK_LEADER);
    mockPrisma.follow.findUnique.mockResolvedValue(MOCK_FOLLOW); // status: ACTIVE

    const res = await app.inject({
      method: 'POST',
      url: '/follows',
      headers: AUTH,
      payload: { leaderAddress: VALID_ADDRESS },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.code).toBe('ALREADY_FOLLOWING');
  });

  it('re-activates a REMOVED follow instead of erroring', async () => {
    mockAuthSession(mockPrisma);
    mockPrisma.leader.findUnique.mockResolvedValue(MOCK_LEADER);
    mockPrisma.follow.findUnique.mockResolvedValue({ ...MOCK_FOLLOW, status: 'REMOVED' });
    mockPrisma.follow.upsert.mockResolvedValue({ ...MOCK_FOLLOW, status: 'ACTIVE' });
    mockPrisma.auditLog.create.mockResolvedValue({});

    const res = await app.inject({
      method: 'POST',
      url: '/follows',
      headers: AUTH,
      payload: { leaderAddress: VALID_ADDRESS },
    });

    expect(res.statusCode).toBe(201);
  });

  it('returns 400 for missing leaderAddress', async () => {
    mockAuthSession(mockPrisma);

    const res = await app.inject({
      method: 'POST',
      url: '/follows',
      headers: AUTH,
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });
});

// ── Tests: DELETE /follows/:followId ─────────────────────────────────────────

describe('DELETE /follows/:followId', () => {
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
    const res = await app.inject({ method: 'DELETE', url: '/follows/follow-1' });
    expect(res.statusCode).toBe(401);
  });

  it('soft-deletes a follow by setting status to REMOVED', async () => {
    mockAuthSession(mockPrisma);
    mockPrisma.follow.findFirst.mockResolvedValue(MOCK_FOLLOW);
    mockPrisma.follow.update.mockResolvedValue({ ...MOCK_FOLLOW, status: 'REMOVED' });
    mockPrisma.auditLog.create.mockResolvedValue({});

    const res = await app.inject({
      method: 'DELETE',
      url: '/follows/follow-1',
      headers: AUTH,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(mockPrisma.follow.update).toHaveBeenCalledWith({
      where: { id: 'follow-1' },
      data: { status: 'REMOVED' },
    });
  });

  it('returns 404 for non-existent follow', async () => {
    mockAuthSession(mockPrisma);
    mockPrisma.follow.findFirst.mockResolvedValue(null);

    const res = await app.inject({
      method: 'DELETE',
      url: '/follows/nonexistent',
      headers: AUTH,
    });

    expect(res.statusCode).toBe(404);
  });

  it('only deletes follows owned by the authenticated user', async () => {
    mockAuthSession(mockPrisma);
    mockPrisma.follow.findFirst.mockResolvedValue(null); // other user's follow

    await app.inject({
      method: 'DELETE',
      url: '/follows/follow-1',
      headers: AUTH,
    });

    expect(mockPrisma.follow.findFirst).toHaveBeenCalledWith({
      where: { id: 'follow-1', userId: 'user-1' },
    });
  });

  it('creates audit log on deletion', async () => {
    mockAuthSession(mockPrisma);
    mockPrisma.follow.findFirst.mockResolvedValue(MOCK_FOLLOW);
    mockPrisma.follow.update.mockResolvedValue({ ...MOCK_FOLLOW, status: 'REMOVED' });
    mockPrisma.auditLog.create.mockResolvedValue({});

    await app.inject({
      method: 'DELETE',
      url: '/follows/follow-1',
      headers: AUTH,
    });

    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        action: 'FOLLOW_REMOVED',
      }),
    });
  });
});
