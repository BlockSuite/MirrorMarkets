# Production Runbook

## Deployment

### Initial Setup
1. Provision PostgreSQL database
2. Provision Redis instance
3. Set all environment variables from `.env.example`
4. Configure Dynamic.xyz environment and get API key for Server Wallets
5. Run `pnpm db:push` to create database schema (includes Phase 2A `ServerWallet` table)
6. Deploy API, Workers, and Web services

### Railway Deployment
```bash
# API service
railway up --service api

# Workers service
railway up --service workers

# Web service
railway up --service web
```

### Phase 2A Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DYNAMIC_API_KEY` | Production | Dynamic.xyz API key for Server Wallet creation and signing |
| `DYNAMIC_SERVER_WALLET_ENV` | No | `sandbox` or `production` (default: `sandbox`) |
| `USE_SERVER_WALLETS` | No | `true` (default) to use Dynamic Server Wallets for new users |
| `TRADING_KEY_ENCRYPTION_KEY` | Migration only | AES-256 key for decrypting Phase 1 private keys during migration |

## Monitoring

### Health Check
- `GET /health` - Basic liveness
- `GET /system/status` - Full system status including workers, external services, and Dynamic API

### System Status Fields (Phase 2A)
```json
{
  "api": "healthy | degraded | down",
  "workers": { "copyTrading": "...", "autoClaim": "...", ... },
  "external": {
    "polymarket": "healthy | degraded | down",
    "dynamic": "healthy | degraded | down"
  },
  "dynamicApi": "healthy | degraded | down"
}
```

### Worker Heartbeats
Workers write last-ping timestamps to Redis:
- `worker:copy-trading:last-ping`
- `worker:auto-claim:last-ping`
- `worker:health-check:last-ping`
- `worker:position-sync:last-ping`

Alert if any ping is >2 minutes stale.

### System Health Key
- `system:health` - JSON blob with latest health check results (120s TTL)

### Dynamic API Health
- Checked via `GET https://app.dynamicauth.com/api/v0/health`
- If Dynamic API is down, system status degrades to `DEGRADED`
- All signing operations will fail with `SIGNING_UNAVAILABLE`
- Copy trading auto-pauses when Dynamic API is unreachable

## Phase 2A Migration

### Pre-Migration Checklist
- [ ] `DYNAMIC_API_KEY` is set and verified (test with `GET /system/status`)
- [ ] `TRADING_KEY_ENCRYPTION_KEY` is set (needed to decrypt Phase 1 keys for ownership transfer)
- [ ] Database backup taken
- [ ] Copy trading is paused (`UPDATE copy_profiles SET status = 'PAUSED' WHERE status = 'ENABLED'`)
- [ ] No pending orders or withdrawals

### Running the Migration
```bash
# Preview (dry run) — no database changes
DYNAMIC_API_KEY=xxx DATABASE_URL=xxx TRADING_KEY_ENCRYPTION_KEY=xxx \
  npx tsx scripts/migrate-phase2a.ts --dry-run

# Production run — all users
DYNAMIC_API_KEY=xxx DATABASE_URL=xxx TRADING_KEY_ENCRYPTION_KEY=xxx \
  npx tsx scripts/migrate-phase2a.ts

# Single user migration
DYNAMIC_API_KEY=xxx DATABASE_URL=xxx TRADING_KEY_ENCRYPTION_KEY=xxx \
  npx tsx scripts/migrate-phase2a.ts --user=<userId>
```

### Migration Steps (per user)
1. **Create Server Wallet**: Calls Dynamic API to create MPC server wallet
2. **Store in DB**: Creates `ServerWallet` record with `READY` status
3. **Transfer Ownership**: Transfers proxy wallet ownership from old trading EOA to new server wallet address
4. **Destroy Private Key**: Sets `encPrivKey` to `NULL` in Wallet table
5. **Audit Log**: Records `MIGRATION_STARTED`, `SERVER_WALLET_CREATED`, `OWNERSHIP_TRANSFERRED`, `PRIVATE_KEY_DESTROYED`, `MIGRATION_COMPLETED`

### Post-Migration Verification
```sql
-- Verify all users have server wallets
SELECT u.id, u.email, sw.address, sw.status
FROM users u
LEFT JOIN server_wallets sw ON u.id = sw.user_id
WHERE u.id IN (SELECT DISTINCT user_id FROM wallets WHERE type = 'TRADING_EOA');

-- Verify no remaining encrypted private keys
SELECT COUNT(*) FROM wallets WHERE enc_priv_key IS NOT NULL;

-- Check for failed migrations
SELECT * FROM audit_logs WHERE action = 'MIGRATION_STARTED'
  AND user_id NOT IN (SELECT user_id FROM audit_logs WHERE action = 'MIGRATION_COMPLETED');
```

### Rollback
The migration script is idempotent — re-running skips already-migrated users. However, if a server wallet was created but ownership transfer failed:
1. The old trading EOA still owns the proxy wallet (safe state)
2. `encPrivKey` was NOT yet nullified (destruction happens after transfer)
3. Re-run the migration for the specific user: `--user=<userId>`

**There is no automated rollback.** If Dynamic Server Wallet creation succeeds but ownership transfer fails, the system is in a dual-authority state. The old trading EOA retains ownership, so funds are safe. Fix the transfer issue and re-run.

## Common Operations

### Pause Copy Trading for All Users
```sql
UPDATE copy_profiles SET status = 'PAUSED' WHERE status = 'ENABLED';
```

### Resume Copy Trading
```sql
UPDATE copy_profiles SET status = 'ENABLED' WHERE status = 'PAUSED';
```

### Reconcile Stale Orders
```bash
curl -X POST https://api.mirrormarkets.xyz/admin/reconcile \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### Retry Failed Relayer Transaction
```bash
curl -X POST https://api.mirrormarkets.xyz/admin/retry-relayer \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"txId": "TX_ID_HERE"}'
```

### View Recent Audit Logs
```sql
SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 50;
```

### View Signing Audit Logs (Phase 2A)
```sql
-- All signing requests for a user
SELECT * FROM audit_logs
WHERE user_id = 'USER_ID'
  AND action IN ('SIGNING_REQUESTED', 'SIGNING_COMPLETED', 'SIGNING_FAILED')
ORDER BY created_at DESC LIMIT 20;

-- Failed signing attempts
SELECT * FROM audit_logs
WHERE action = 'SIGNING_FAILED'
ORDER BY created_at DESC LIMIT 50;
```

### Check User's Server Wallet
```sql
SELECT sw.*, u.email
FROM server_wallets sw
JOIN users u ON sw.user_id = u.id
WHERE sw.user_id = 'USER_ID';
```

### Check User's Copy Attempts
```sql
SELECT ca.*, le.side, le.size, le.price, le.market_slug
FROM copy_attempts ca
JOIN leader_events le ON ca.leader_event_id = le.id
WHERE ca.user_id = 'USER_ID'
ORDER BY ca.created_at DESC
LIMIT 20;
```

## Incident Response

### Dynamic API Key Compromise
1. **Immediately** rotate `DYNAMIC_API_KEY` on the Dynamic.xyz dashboard
2. Redeploy all services (API + Workers) with the new key
3. All existing server wallets continue working with the new key
4. Review audit logs for suspicious signing activity:
   ```sql
   SELECT * FROM audit_logs
   WHERE action IN ('SIGNING_REQUESTED', 'SERVER_WALLET_CREATED')
     AND created_at > NOW() - INTERVAL '24 hours'
   ORDER BY created_at DESC;
   ```
5. Enable IP allowlisting on the Dynamic dashboard to prevent future abuse

### Server Wallet Compromise (Suspected)
1. Identify affected user(s)
2. Pause copy trading for affected users:
   ```sql
   UPDATE copy_profiles SET status = 'PAUSED' WHERE user_id = 'USER_ID';
   ```
3. Mark server wallet as failed:
   ```sql
   UPDATE server_wallets SET status = 'FAILED' WHERE user_id = 'USER_ID';
   ```
4. Create new server wallet and transfer proxy ownership (use `tradingAuthority.rotate(userId)` if available, or re-run migration)
5. Record incident in audit log

### Dynamic.xyz Outage
1. System automatically enters `DEGRADED` state (visible at `GET /system/status`)
2. Copy trading auto-pauses — no new trades will be placed
3. Manual orders return `SIGNING_UNAVAILABLE` error
4. Monitor Dynamic status page
5. Recovery is automatic when Dynamic API comes back online
6. **No manual intervention needed** — the circuit breaker and retry logic handle this

### Circuit Breaker Triggered
1. Check `GET /system/status` for which service is degraded
2. Check API logs for error patterns
3. If Polymarket API is down, wait for recovery (circuit breaker auto-recovers after 60s)
4. If Dynamic API is down, see "Dynamic.xyz Outage" above
5. If persistent, check Polymarket/Dynamic status pages

### Worker Stopped
1. Check Redis heartbeat keys
2. Check worker container logs
3. Restart worker service
4. Verify worker resumes processing

### Failed Withdrawals
1. Query `relayer_txs` table for failed entries
2. Check Polymarket relayer status
3. Retry via admin endpoint or manual DB update
4. Verify on-chain that funds are safe

### Database Connection Issues
1. Check connection pool limits
2. Verify DATABASE_URL is correct
3. Check PostgreSQL logs
4. Consider increasing pool size in Prisma

## Backup & Recovery

### Database
- Automated daily backups via cloud provider (Railway)
- Point-in-time recovery available
- Test restore quarterly

### Encryption Keys (Phase 2A)
- `DYNAMIC_API_KEY` — can be rotated on Dynamic dashboard; no data loss
- `TRADING_KEY_ENCRYPTION_KEY` — only needed during migration; can be removed after all users are migrated
- Server wallet private keys are managed by Dynamic.xyz (MPC sharded) — no backup needed on our side

### Key Lifecycle (Phase 2A)
| Operation | How |
|-----------|-----|
| Create server wallet | `tradingAuthority.getAddress(userId)` (auto-creates on first call) |
| Rotate server wallet | `tradingAuthority.rotate(userId)` — creates new wallet, transfers proxy ownership |
| Revoke server wallet | `tradingAuthority.revoke(userId)` — marks FAILED, pauses copy trading |
| Export private key | **Not possible** — MPC keys cannot be exported from Dynamic.xyz |

## Scaling

### Horizontal Scaling
- API: Stateless, can run multiple instances behind load balancer
- Workers: Use BullMQ's built-in concurrency (single instance recommended to avoid duplicate processing)
- Web: Stateless Next.js, can run multiple instances

### Vertical Scaling
- Increase worker poll intervals to reduce load
- Add database read replicas for query-heavy operations
- Redis cluster for high-throughput scenarios

### Dynamic API Throughput
- Each user signing operation makes 1 HTTP call to Dynamic API
- Exponential backoff (base 500ms, max 3 retries) for transient failures
- 429 responses respect `Retry-After` header
- If signing throughput is a bottleneck, contact Dynamic.xyz for rate limit increases
