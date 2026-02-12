// Domain types - mirrors Prisma models for API layer

export interface UserProfile {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  createdAt: string;
}

export interface WalletInfo {
  type: 'DYNAMIC_EOA' | 'TRADING_EOA' | 'SERVER_WALLET' | 'POLY_PROXY';
  address: string;
}

export interface ServerWalletInfo {
  id: string;
  userId: string;
  dynamicServerWalletId: string;
  address: string;
  status: 'CREATING' | 'READY' | 'FAILED';
  createdAt: string;
}

export interface ProvisioningStatus {
  dynamicEoa: boolean;
  tradingEoa: boolean;
  serverWallet: boolean;
  serverWalletCreating: boolean;
  serverWalletReady: boolean;
  polyProxy: boolean;
  clobApiKey: boolean;
  copyProfile: boolean;
  complete: boolean;
}

export interface LeaderInfo {
  id: string;
  address: string;
  displayName: string | null;
  profileImageUrl: string | null;
  pnl: number;
  volume: number;
  rank: number | null;
}

export interface FollowInfo {
  id: string;
  leader: LeaderInfo;
  status: 'ACTIVE' | 'PAUSED' | 'REMOVED';
  createdAt: string;
}

export interface CopyProfileInfo {
  status: 'DISABLED' | 'ENABLED' | 'PAUSED';
  maxPositionSizeUsd: number;
  maxOpenPositions: number;
  copyPercentage: number;
  minOdds: number;
  maxOdds: number;
  enabledMarketIds: string[];
  blockedMarketIds: string[];
}

export interface CopyAttemptInfo {
  id: string;
  leaderEvent: LeaderEventInfo;
  status: 'PENDING' | 'SUBMITTED' | 'FILLED' | 'PARTIALLY_FILLED' | 'FAILED' | 'SKIPPED';
  skipReason: string | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface LeaderEventInfo {
  id: string;
  leaderId: string;
  conditionId: string;
  tokenId: string;
  marketSlug: string | null;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  detectedAt: string;
}

export interface OrderInfo {
  id: string;
  polyOrderId: string | null;
  conditionId: string;
  tokenId: string;
  marketSlug: string | null;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  filledSize: number;
  status: 'OPEN' | 'FILLED' | 'PARTIALLY_FILLED' | 'CANCELLED' | 'EXPIRED';
  createdAt: string;
}

export interface FillInfo {
  id: string;
  orderId: string;
  size: number;
  price: number;
  side: 'BUY' | 'SELL';
  fee: number;
  filledAt: string;
}

export interface PositionInfo {
  conditionId: string;
  tokenId: string;
  marketSlug: string | null;
  size: number;
  avgPrice: number;
  currentPrice: number;
  pnl: number;
}

export interface WithdrawalInfo {
  id: string;
  amount: number;
  destinationAddr: string;
  status: 'PENDING' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED';
  transactionHash: string | null;
  createdAt: string;
}

export interface AutoClaimSettingsInfo {
  enabled: boolean;
  minClaimableUsd: number;
}

export interface SystemStatus {
  api: 'ok' | 'degraded' | 'down';
  database: 'ok' | 'degraded' | 'down';
  redis: 'ok' | 'degraded' | 'down';
  dynamicApi: 'ok' | 'degraded' | 'down';
  polymarketClob: 'ok' | 'degraded' | 'down';
  relayer: 'ok' | 'degraded' | 'down';
  workers: {
    copyTrading: 'running' | 'stopped' | 'error';
    autoClaim: 'running' | 'stopped' | 'error';
    healthCheck: 'running' | 'stopped' | 'error';
    positionSync: 'running' | 'stopped' | 'error';
  };
  lastCheckedAt: string;
}

export interface AuditLogInfo {
  id: string;
  action: string;
  details: Record<string, unknown> | null;
  createdAt: string;
}

export interface SSEEvent {
  type: 'copy_attempt' | 'order_update' | 'fill' | 'audit' | 'system';
  data: Record<string, unknown>;
  timestamp: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}
