# Documentation Verification Checklist

Items to verify against upstream documentation before production deployment.

## Phase 2A: Dynamic Server Wallets

### Dynamic.xyz Server Wallet API

- [ ] Verify Server Wallet creation endpoint: `POST /api/v0/environments/{envId}/embeddedWallets/server`
- [ ] Verify Server Wallet signing endpoint: `POST /api/v0/environments/{envId}/embeddedWallets/{walletId}/sign`
- [ ] Verify signing request payload format: `{ type: "personal_sign" | "sign_typed_data", params: {...} }`
- [ ] Verify `sign_typed_data` params include `{ domain, types, primaryType, message }` (EIP-712)
- [ ] Verify `personal_sign` params include `{ message: "0x..." }` (hex-encoded)
- [ ] Verify API key authentication: `Authorization: Bearer <DYNAMIC_API_KEY>`
- [ ] Verify Server Wallet response includes `{ id, address, chains }` on creation
- [ ] Verify signing response includes `{ signature }` field
- [ ] Verify rate limits on Server Wallet API (document limits, verify 429 + `Retry-After` header)
- [ ] Verify sandbox vs production environment behavior
- [ ] Verify health check endpoint: `GET https://app.dynamicauth.com/api/v0/health`

### Dynamic.xyz JWT Verification

- [ ] Verify JWT issuer is `app.dynamic.xyz`
- [ ] Verify RSA public key format (SPKI vs PKCS1)
- [ ] Verify JWT payload includes `verified_credentials` array
- [ ] Verify embedded wallet private key export is NOT required (using Server Wallet for signing)

### Server Wallet Lifecycle

- [ ] Verify that MPC keys cannot be exported from Dynamic.xyz (confirm documentation states this)
- [ ] Verify Server Wallet deletion/revocation API (if available)
- [ ] Verify wallet ID is stable across API key rotations
- [ ] Verify multiple server wallets per environment are supported

## Polymarket CLOB Client (@polymarket/clob-client v5)

- [ ] Verify `signatureType=1` (POLY_PROXY) is correct for proxy wallets
- [ ] Verify `createOrder` params shape matches current SDK version
- [ ] Verify `postOrder` response shape for `orderID` field name
- [ ] Verify `cancelOrder` accepts order ID string directly
- [ ] Verify API key derivation via `createApiKey()` method signature
- [ ] Verify CLOB API base URL is still `https://clob.polymarket.com`
- [ ] Verify ClobClient accepts a duck-typed signer (not strictly `ethers.Wallet`) — important for `ServerWalletSigner`

## Polymarket Builder Relayer

- [ ] Verify relayer endpoint URL (`https://relayer.polymarket.com/relay`)
- [ ] Verify relay request payload format (`type: 'PROXY'`, `transactions` array)
- [ ] Verify signature scheme (message signing vs typed data) — Phase 2A signs via `TradingAuthorityProvider.signMessage()`
- [ ] Verify proxy wallet auto-deployment on first relayer tx
- [ ] Verify response shape includes `transactionHash`
- [ ] Verify relayer accepts signatures from any EOA that owns the proxy (important for migration: new server wallet must be proxy owner)

## Polymarket Data API

- [ ] Verify trades endpoint: `GET /trades?maker=ADDRESS`
- [ ] Verify positions endpoint: `GET /positions?address=ADDRESS`
- [ ] Verify field names in trade/position response objects

## Polymarket Gamma API

- [ ] Verify leaderboard endpoint: `GET /leaderboard?window=all&limit=50`
- [ ] Verify search endpoint: `GET /search?query=QUERY&type=user`
- [ ] Verify response field names match expectations

## Smart Contracts (Polygon)

- [ ] Verify CTF Exchange address: `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E`
- [ ] Verify NegRisk CTF Exchange address: `0xC5d563A36AE78145C45a50134d48A1215220f80a`
- [ ] Verify USDC address: `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`
- [ ] Verify Conditional Tokens address: `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045`
- [ ] Verify `redeemPositions` function signature and index sets `[1, 2]`

## Proxy Wallet Derivation

- [ ] Verify CREATE2 derivation mechanism from trading EOA (or Server Wallet address)
- [ ] Document exact factory contract and salt used
- [ ] Test proxy address derivation matches on-chain
- [ ] Verify proxy ownership transfer mechanism (Safe `swapOwner` or equivalent) for Phase 2A migration

## Rate Limits

- [ ] Document Polymarket CLOB API rate limits
- [ ] Document Gamma API rate limits
- [ ] Document Relayer rate limits
- [ ] Document Dynamic Server Wallet API rate limits
- [ ] Ensure worker poll intervals respect all rate limits
- [ ] Verify exponential backoff parameters (base 500ms, max 3 retries) are appropriate
