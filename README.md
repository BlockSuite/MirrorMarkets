# Mirror Markets (mirrormarkets.xyz)

Polymarket Copy Trading Platform - Follow top traders and automatically copy their trades.

## Architecture

```
mirrormarkets.xyz/
├── apps/web/                  # Next.js 14 (App Router) - Frontend
├── services/api/              # Fastify TypeScript - REST API + SSE
│   └── src/adapters/          # External service integrations
│       ├── dynamic-server-wallet.provider.ts  # Phase 2A: Dynamic MPC signer
│       ├── mock-server-wallet.provider.ts     # Local dev mock signer
│       ├── server-wallet-signer.ts            # ethers-compatible signer wrapper
│       ├── trading-authority.factory.ts        # Provider factory
│       ├── polymarket.adapter.ts              # CLOB client wrapper
│       └── relayer.adapter.ts                 # Gasless tx relayer wrapper
├── services/workers/          # BullMQ workers - Copy engine, Auto-claim, Health
├── packages/shared/           # Shared types, constants, utils
│   └── src/types/
│       └── trading-authority.ts  # TradingAuthorityProvider interface
├── prisma/                    # Prisma schema + migrations
├── scripts/
│   └── migrate-phase2a.ts     # Phase 1 → Phase 2A migration script
├── docker-compose.yml         # Postgres, Redis, API, Workers, Web
```

**Stack**: TypeScript, Next.js 14, Fastify 5, Prisma, BullMQ, Redis, PostgreSQL, Dynamic.xyz, Polymarket CLOB Client

## Phase 2A Architecture (Current)

### Custody Model

Phase 2A eliminates backend raw private key custody. All signing operations are delegated to Dynamic Server Wallets (MPC-backed).

**Per-user wallet model:**

| Wallet | Purpose | Custody |
|--------|---------|---------|
| Dynamic Embedded Wallet | Login identity | User-controlled via Dynamic.xyz |
| Dynamic Server Wallet | Trading authority (signs CLOB orders, relayer txs) | MPC-backed, managed by Dynamic.xyz |
| Polymarket Proxy/Safe | On-chain funder wallet (holds USDC, positions) | Owned by Server Wallet |

**Key principle:** The backend NEVER stores, logs, or handles raw private keys. All signing is done via the Dynamic Server Wallet API.

### TradingAuthorityProvider Abstraction

All signing operations go through a single interface:

```typescript
interface TradingAuthorityProvider {
  getAddress(userId: string): Promise<string>
  signTypedData(userId: string, typedData: EIP712TypedData): Promise<string>
  signMessage(userId: string, message: string | Uint8Array): Promise<string>
  executeTransaction?(userId: string, tx: TransactionRequest): Promise<TransactionResult>
  rotate?(userId: string): Promise<void>
  revoke?(userId: string): Promise<void>
}
```

**Implementations:**

| Provider | Environment | Description |
|----------|-------------|-------------|
| `DynamicServerWalletProvider` | Production | Calls Dynamic.xyz Server Wallet API for all signing |
| `MockDynamicServerWalletProvider` | Development/Test | Uses deterministic keys derived from userId (no external calls) |

### Signing Flow

```
User Request → API Route → WalletService
  → PolymarketAdapter(ServerWalletSigner)
    → ClobClient._signTypedData()
      → ServerWalletSigner._signTypedData()
        → TradingAuthorityProvider.signTypedData(userId, typedData)
          → Dynamic Server Wallet API (MPC sign)
            → Returns signature
```

### Failure Modes

| Scenario | Behavior |
|----------|----------|
| Dynamic API down | System status = DEGRADED, orders return SIGNING_UNAVAILABLE, copy engine pauses |
| Dynamic API rate limited | Exponential backoff with 3 retries, then SIGNING_UNAVAILABLE |
| Server wallet creation fails | User stays in provisioning, retry allowed |
| Server wallet compromised | Call `revoke(userId)`: wallet marked FAILED, copy trading paused |

## Prerequisites

- Node.js >= 20
- pnpm >= 9
- Docker & Docker Compose (for local dev)

## Quick Start

```bash
# Install dependencies
pnpm install

# Copy env file and configure
cp .env.example .env

# Start Postgres & Redis
docker compose up postgres redis -d

# Generate Prisma client and push schema
pnpm db:generate
pnpm db:push

# Run all services in dev mode
pnpm dev
```

## Services

| Service | Port | Description |
|---------|------|-------------|
| Web | 3000 | Next.js frontend |
| API | 3001 | Fastify REST API + SSE |
| Workers | - | Background copy engine, auto-claim, health checks |

## Key Features

- **Email Login**: Dynamic.xyz embedded wallets for seamless auth
- **MPC Custody (Phase 2A)**: No backend private keys — Dynamic Server Wallets
- **Copy Trading**: Automatic trade copying with configurable guardrails
- **Guardrails**: Max position size, max open positions, copy percentage, odds range
- **Circuit Breaker**: Auto-pauses copy trading after consecutive failures
- **Deposits/Withdrawals**: Gasless via Polymarket relayer
- **Auto-Claim**: Automatic redemption of resolved positions
- **Real-time Logs**: SSE-powered daemon log streaming
- **System Health**: Worker monitoring + Dynamic API health checks

## API Endpoints

### Auth
- `POST /auth/dynamic/verify` - Verify Dynamic JWT, create session
- `POST /auth/logout` - Destroy session

### Wallets
- `POST /wallets/provision` - Full provisioning pipeline (creates server wallet)
- `GET /wallets/me` - Current user profile
- `GET /wallets/me/wallets` - User wallet addresses
- `GET /wallets/me/provisioning-status` - Provisioning progress (includes serverWallet status)

### Leaders
- `GET /leaders/leaderboard` - Fetch leaderboard

### Follows
- `POST /follows` - Follow a leader
- `GET /follows` - List follows
- `DELETE /follows/:id` - Unfollow

### Copy Trading
- `PUT /copy/profile` - Update guardrails
- `POST /copy/enable` - Start copy trading
- `POST /copy/disable` - Stop copy trading
- `GET /copy/logs` - Paginated copy attempts
- `GET /copy/logs/stream` - SSE live log stream

### Orders & Fills
- `POST /orders` - Place order (signed via server wallet)
- `GET /orders` - List orders
- `POST /orders/:id/cancel` - Cancel order
- `GET /fills` - List fills

### Portfolio
- `GET /portfolio/balances` - USDC + position values
- `GET /portfolio/positions` - Open positions

### Funds
- `GET /funds/deposit-address` - Proxy wallet deposit address
- `POST /funds/withdrawals` - Initiate withdrawal (signed via server wallet)
- `GET /funds/withdrawals` - Withdrawal history

### Claims
- `GET /claims/claimable` - Claimable positions
- `POST /claims/redeem` - Redeem position (signed via server wallet)
- `PUT /claims/auto-claim` - Toggle auto-claim
- `GET /claims/auto-claim` - Auto-claim settings

### System
- `GET /system/status` - System health (includes Dynamic API status)
- `GET /health` - Simple health check

## Phase 2A Migration

### Migration Steps

1. **Deploy new code** with dual-provider support (`USE_SERVER_WALLETS=true`).
2. **New users** automatically get `DynamicServerWalletProvider`.
3. **Run migration script** for existing users:
   ```bash
   # Preview (dry run)
   npx tsx scripts/migrate-phase2a.ts --dry-run

   # Production run
   DYNAMIC_API_KEY=xxx DATABASE_URL=xxx TRADING_KEY_ENCRYPTION_KEY=xxx \
     npx tsx scripts/migrate-phase2a.ts

   # Single user
   npx tsx scripts/migrate-phase2a.ts --user=<userId>
   ```
4. **Verify** orders and claims still work for migrated users.
5. **Disable legacy provider** by removing `TRADING_KEY_ENCRYPTION_KEY` from env.
6. **Remove** the `encPrivKey` column from the Wallet table (optional cleanup migration).

### Migration Script Details

The script `scripts/migrate-phase2a.ts`:
- Is idempotent (safe to re-run).
- Processes each user in a try/catch — one failure does not block others.
- Creates audit log entries for every step (MIGRATION_STARTED, SERVER_WALLET_CREATED, OWNERSHIP_TRANSFERRED, PRIVATE_KEY_DESTROYED, MIGRATION_COMPLETED).
- Supports `--dry-run` mode to preview without changes.
- Supports `--user=<id>` for single-user migration.
- Exits with code 1 if any users failed.

## Docker Deployment

```bash
docker compose up --build
```

## Testing

```bash
pnpm test
```

## Environment Variables

See `.env.example` for all required variables.

### Phase 2A Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DYNAMIC_API_KEY` | Production | Dynamic.xyz server API key for Server Wallets |
| `DYNAMIC_SERVER_WALLET_ENV` | No | `sandbox` or `production` (default: `sandbox`) |
| `USE_SERVER_WALLETS` | No | `true` (default) to use Dynamic Server Wallets for new users |
| `TRADING_KEY_ENCRYPTION_KEY` | Migration only | AES-256 key for decrypting Phase 1 private keys |

## License

Proprietary - All rights reserved.
