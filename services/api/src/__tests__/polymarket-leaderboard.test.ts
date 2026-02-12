import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock heavy dependencies before any adapter import
vi.mock('@polymarket/clob-client', () => ({ ClobClient: vi.fn() }));
vi.mock('@polymarket/clob-client/dist/types.js', () => ({
  Side: { BUY: 0, SELL: 1 },
  AssetType: { CONDITIONAL: 'CONDITIONAL' },
}));
vi.mock('../adapters/server-wallet-signer.js', () => ({
  ServerWalletSigner: vi.fn(),
}));
vi.mock('../config.js', () => ({
  getConfig: () => ({
    POLYMARKET_DATA_API_URL: 'https://data-api.polymarket.com',
    POLYMARKET_CLOB_API_URL: 'https://clob.polymarket.com',
  }),
}));

const { normalizeLeader, PolymarketAdapter } = await import(
  '../adapters/polymarket.adapter.js'
);

type LeaderFromApi = Awaited<ReturnType<typeof PolymarketAdapter.fetchLeaderboard>>[number];

// ── normalizeLeader unit tests ──────────────────────────────────────────────

describe('normalizeLeader', () => {
  it('maps Polymarket raw fields to normalized shape', () => {
    const raw = {
      rank: '1',
      proxyWallet: '0xAbC123',
      userName: 'Theo4',
      xUsername: '',
      verifiedBadge: false,
      vol: 43251303.17,
      pnl: 22053933.75,
      profileImage: 'https://example.com/pic.jpg',
    };

    const result = normalizeLeader(raw);

    expect(result).toEqual({
      address: '0xabc123',
      displayName: 'Theo4',
      profileImageUrl: 'https://example.com/pic.jpg',
      pnl: 22053933.75,
      volume: 43251303.17,
      rank: 1,
    });
  });

  it('handles empty strings as null for display fields', () => {
    const raw = {
      rank: '5',
      proxyWallet: '0xDEF456',
      userName: '',
      profileImage: '',
      vol: 100,
      pnl: 50,
    };

    const result = normalizeLeader(raw);

    expect(result.displayName).toBeNull();
    expect(result.profileImageUrl).toBeNull();
  });

  it('handles missing fields with safe defaults', () => {
    const result = normalizeLeader({});

    expect(result).toEqual({
      address: '',
      displayName: null,
      profileImageUrl: null,
      pnl: 0,
      volume: 0,
      rank: 0,
    });
  });

  it('parses string rank to integer', () => {
    expect(normalizeLeader({ rank: '42' }).rank).toBe(42);
    expect(normalizeLeader({ rank: 'not-a-number' }).rank).toBe(0);
    expect(normalizeLeader({ rank: undefined }).rank).toBe(0);
  });
});

// ── fetchLeaderboard / searchUsers with mocked fetch ────────────────────────

const SAMPLE_RAW_LEADERS = [
  {
    rank: '1',
    proxyWallet: '0xAAA',
    userName: 'Alice',
    profileImage: '',
    vol: 1000,
    pnl: 500,
  },
  {
    rank: '2',
    proxyWallet: '0xBBB',
    userName: 'Bob',
    profileImage: 'https://img.example.com/bob.png',
    vol: 800,
    pnl: 300,
  },
];

describe('PolymarketAdapter.fetchLeaderboard', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls the correct data-api URL', async () => {
    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => SAMPLE_RAW_LEADERS,
    });

    await PolymarketAdapter.fetchLeaderboard();

    expect(fetch).toHaveBeenCalledWith(
      'https://data-api.polymarket.com/v1/leaderboard?timePeriod=ALL&orderBy=PNL&limit=50',
    );
  });

  it('returns normalized leaders', async () => {
    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => SAMPLE_RAW_LEADERS,
    });

    const leaders = await PolymarketAdapter.fetchLeaderboard();

    expect(leaders).toHaveLength(2);
    expect(leaders[0]).toEqual<LeaderFromApi>({
      address: '0xaaa',
      displayName: 'Alice',
      profileImageUrl: null,
      pnl: 500,
      volume: 1000,
      rank: 1,
    });
    expect(leaders[1].address).toBe('0xbbb');
  });

  it('throws on non-OK response', async () => {
    (fetch as any).mockResolvedValue({ ok: false, status: 404 });

    await expect(PolymarketAdapter.fetchLeaderboard()).rejects.toThrow(
      'Leaderboard fetch failed: 404',
    );
  });
});

describe('PolymarketAdapter.searchUsers', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls the correct data-api URL with userName param', async () => {
    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => [],
    });

    await PolymarketAdapter.searchUsers('Theo');

    expect(fetch).toHaveBeenCalledWith(
      'https://data-api.polymarket.com/v1/leaderboard?userName=Theo&timePeriod=ALL&limit=20',
    );
  });

  it('encodes special characters in the query', async () => {
    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => [],
    });

    await PolymarketAdapter.searchUsers('a b&c');

    expect(fetch).toHaveBeenCalledWith(
      'https://data-api.polymarket.com/v1/leaderboard?userName=a%20b%26c&timePeriod=ALL&limit=20',
    );
  });

  it('returns normalized results', async () => {
    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => [SAMPLE_RAW_LEADERS[0]],
    });

    const results = await PolymarketAdapter.searchUsers('Alice');

    expect(results).toHaveLength(1);
    expect(results[0].displayName).toBe('Alice');
    expect(results[0].address).toBe('0xaaa');
  });

  it('throws on non-OK response', async () => {
    (fetch as any).mockResolvedValue({ ok: false, status: 500 });

    await expect(PolymarketAdapter.searchUsers('test')).rejects.toThrow(
      'User search failed: 500',
    );
  });
});
