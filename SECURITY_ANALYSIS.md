# Phase 2A Security Analysis

## Threat Model

### Attack Surface Changes

| Surface | Phase 1 | Phase 2A | Risk Delta |
|---------|---------|----------|------------|
| Database compromise | Encrypted private keys exposed; AES-256-GCM key needed to decrypt | No private keys stored; ServerWallet table has only Dynamic wallet IDs and public addresses | **Reduced**: attacker gains no signing capability |
| Backend process memory | Private keys exist in memory during signing operations | No private keys in memory; signing happens remotely at Dynamic.xyz | **Reduced**: memory dump yields no secrets |
| Env var leak | `TRADING_KEY_ENCRYPTION_KEY` gives access to all user keys | `DYNAMIC_API_KEY` allows creating wallets and requesting signatures | **Changed**: API key must be protected; key rotation supported by Dynamic |
| Man-in-the-middle | Private keys never leave the server | Signing payloads traverse HTTPS to Dynamic API | **Minimal change**: TLS protects in transit |
| Insider threat | Developer with DB access + env vars can steal all funds | Developer with `DYNAMIC_API_KEY` can request signatures but cannot export keys | **Reduced**: MPC architecture prevents key export |

### Residual Risks

1. **Dynamic API key compromise**: An attacker with `DYNAMIC_API_KEY` can create wallets and request signatures. Mitigation: IP allowlisting on Dynamic dashboard, key rotation, audit logging.

2. **Dynamic.xyz availability**: Single point of failure for all signing. Mitigation: Circuit breaker pauses trading, system status shows DEGRADED, orders fail gracefully.

3. **Dynamic.xyz compromise**: If Dynamic's MPC infrastructure is compromised, all server wallets are at risk. Mitigation: This is an inherent trust boundary; comparable to trusting a KMS provider. Dynamic's SOC 2 compliance and MPC architecture reduce this risk.

4. **Proxy ownership transfer during migration**: During the migration window, both old and new signing authorities may exist. Mitigation: Migration script transfers ownership atomically per user; audit trail.

## Security Controls

### Logging and Audit

- Every signing request generates an audit log entry with a correlation ID.
- Every signing completion/failure is logged.
- Migration operations are fully audit-logged.
- Sensitive data (signing payloads, wallet secrets) are NEVER logged.

### Rate Limiting

- Dynamic API calls use exponential backoff (base 500ms, max 3 retries).
- 429 responses from Dynamic respect the Retry-After header.
- The API rate limiter (100 req/min) also bounds signing throughput.

### Signing Request Validation

- All signing requests require an authenticated session (Bearer token).
- userId is extracted from the session, not from user input.
- Multi-tenant isolation: each user's server wallet is keyed by userId; cross-user signing is impossible.

### Key Lifecycle

| Operation | Supported | How |
|-----------|-----------|-----|
| Create | Yes | `ProvisioningService.provision()` or `tradingAuthority.getAddress()` |
| Rotate | Yes | `tradingAuthority.rotate(userId)` — creates new wallet, transfers ownership |
| Revoke | Yes | `tradingAuthority.revoke(userId)` — marks FAILED, pauses copy trading |
| Export | No | MPC keys cannot be exported from Dynamic.xyz |
| Backup | N/A | Dynamic.xyz handles key backup via MPC sharding |

### Network Security

- Dynamic API calls use HTTPS (TLS 1.3).
- API key is sent via Authorization header (not query parameter).
- Request timeout: 15 seconds to prevent hanging connections.
- No signing payloads are logged (only metadata: userId, correlationId, operation type).

## Compliance Considerations

- **No PCI DSS scope**: No credit card data processed.
- **SOC 2**: Dynamic.xyz provides SOC 2 compliance for their MPC infrastructure.
- **GDPR**: User email and wallet addresses are PII; deletion supported via Prisma cascade.
- **Key custody**: Backend never possesses raw private keys — reduces regulatory burden compared to Phase 1.

## Incident Response

1. **Suspected API key leak**: Rotate `DYNAMIC_API_KEY` on Dynamic dashboard immediately. Redeploy. All existing server wallets continue working with new key.

2. **Suspected server wallet compromise**: Call `tradingAuthority.revoke(userId)` for affected user(s). Create new server wallet via `rotate(userId)`. Transfer proxy ownership.

3. **Dynamic.xyz outage**: System automatically enters DEGRADED state. Copy trading pauses. Manual orders return SIGNING_UNAVAILABLE. Monitor Dynamic status page. Resume is automatic on recovery.
