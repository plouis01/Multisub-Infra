# MultiSubs Infrastructure

MultiSubs is a multi-tenant Banking-as-a-Service platform that lets companies offer USDC custody, card spending, on-chain settlement, and yield — all on Base. This document explains how the system works end to end.

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Tenant Application                          │
│                    (Web2 company's own backend)                     │
└──────────────────────────────┬──────────────────────────────────────┘
                               │  REST API (X-API-Key)
                               │  Webhooks (HMAC-signed)
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       MultiSubs Backend                             │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐     │
│  │  Express API │  │  Auth Engine  │  │  Settlement Service   │     │
│  │  /v1 routes  │  │  <300ms auth  │  │  BullMQ → on-chain    │     │
│  └──────────────┘  └──────────────┘  └────────────────────────┘     │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐     │
│  │   Watcher    │  │ Sweep Service│  │    Yield Manager       │     │
│  │  event index │  │  M2 → M1     │  │  Morpho snapshots      │     │
│  └──────────────┘  └──────────────┘  └────────────────────────┘     │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐                                 │
│  │   Webhook    │  │   Lithic &   │                                 │
│  │  Dispatcher  │  │   Sumsub     │                                 │
│  └──────────────┘  └──────────────┘                                 │
└───────┬──────────────────┬──────────────────┬───────────────────────┘
        │                  │                  │
        ▼                  ▼                  ▼
┌──────────────┐  ┌──────────────┐  ┌────────────────────────────────┐
│  PostgreSQL  │  │    Redis     │  │       Base Blockchain          │
│  (Prisma)    │  │  (ioredis)   │  │                                │
│              │  │              │  │  M2 Safes    M1 Treasury       │
│  10 models   │  │  Auth cache  │  │  SpendSettler  DeFiInteractor  │
│  System of   │  │  Rate limits │  │  SafeFactory   TreasuryVault   │
│  record      │  │  Card maps   │  │  TenantRegistry                │
└──────────────┘  └──────────────┘  └────────────────────────────────┘
```

**Key design principles:**

- **Cache-first authorization** — Card auth decisions happen in <300ms using Redis, not the blockchain.
- **Async settlement** — On-chain settlement is decoupled and runs through a BullMQ queue.
- **Safe-centric custody** — All user funds live in Gnosis Safe wallets controlled via Zodiac modules.
- **Multi-tenant isolation** — Every API call, database query, and ledger entry is scoped to a tenant.

---

## Data Layer

### PostgreSQL (System of Record)

All durable state lives in PostgreSQL, accessed through Prisma 6. The schema has 10 models:

| Model                 | Purpose                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Tenant**            | API key owner. Stores hashed API key, webhook config, custody model (`MODEL_A`/`MODEL_B`), rate limit, status.            |
| **User**              | Tenant-scoped end user. Maps `externalId` (tenant's user ID) to an M2 Safe address and EOA. Tracks KYC status.            |
| **SubAccount**        | One card = one sub-account. Stores Lithic card token, spending limits (daily/monthly in cents), MCC blacklist, status.    |
| **Transaction**       | Full lifecycle record: authorization → settlement → reversal. Stores Lithic token, amount, on-chain tx hash, retry count. |
| **BalanceLedger**     | Append-only USDC accounting. Entry types: `deposit`, `spend`, `refund`, `yield`, `sweep`. Amounts in 6-decimal strings.   |
| **YieldLedger**       | Per-tenant yield snapshots. Stores deposited amount, share count, total yield, APY in basis points.                       |
| **SpendSettledEvent** | On-chain `SpendSettled` events indexed by the Watcher. Used for reconciliation.                                           |
| **AuditLog**          | Operational audit trail. Tracks actions like `settlement_executed`, `webhook_delivery_failed`, etc.                       |
| **WatcherMeta**       | Key-value store for the chain indexer cursor (`watcher:lastProcessedBlock`).                                              |

**Amount conventions:**

- Card limits and authorization amounts → **cents** (integer)
- Ledger and treasury amounts → **USDC 6-decimal strings** (e.g., `"1000000"` = 1 USDC)
- Prisma `BigInt` fields → serialized as strings in JSON responses

### Redis (Low-Latency Working Set)

Redis powers the real-time authorization path and operational state:

| Key Pattern                 | Payload                                                                               | TTL  |
| --------------------------- | ------------------------------------------------------------------------------------- | ---- |
| `auth:{eoaAddress}`         | Authorization cache: balance, daily/monthly spent, limits, M2 Safe address, tenant ID | 300s |
| `card:{lithicCardToken}`    | Card mapping: sub-account ID, tenant ID, EOA, M2 Safe, status                         | None |
| `rate:{tenantId}:{window}`  | Sliding window request counter                                                        | 60s  |
| `webhook:processed:{token}` | Replay protection: `"APPROVED"` or `"DECLINED"`                                       | 300s |

**Atomic spend updates** use a Lua script that checks balance, daily limit, and monthly limit in a single atomic operation — preventing double-spend from concurrent authorizations. Falls back to `WATCH/MULTI/EXEC` on cache miss with 3 retries.

---

## Smart Contracts

All contracts are deployed on **Base** (Sepolia for test, Mainnet for production). The architecture is built around Gnosis Safe + Zodiac modules — user funds never sit in custom protocol contracts.

### Contract Topology

```
SafeFactory (CREATE2 deployer)
  │
  ├── deploys → M2 Safe (per-user Gnosis Safe)
  │                ├── SpendSettler module (card settlement)
  │                ├── Roles module (access control)
  │                └── Delay module (time-locked ops)
  │
  └── registers → TenantRegistry (on-chain user↔tenant mapping)

M1 Treasury Safe (platform-level)
  ├── DeFiInteractor module (Morpho + Aave execution)
  └── TreasuryVault (per-tenant share accounting)
```

### SpendSettler

The core settlement contract. Attached as a Zodiac module to each M2 Safe.

**What it does:** When the backend settlement worker calls `settle(amount, lithicTxToken)`, the module executes a USDC transfer from the user's M2 Safe to the platform issuer safe.

**Key mechanics:**

- **Access control** — Only the configured `settler` address can call `settle()`.
- **Idempotency** — A `settledTxTokens` mapping prevents the same Lithic transaction from being settled twice.
- **Pre/post balance check** — The contract verifies USDC actually moved (doesn't trust return values alone).
- **Rolling spend tracking** — A circular buffer of 200 records tracks spend within a 24-hour window.
- **Safety** — `ReentrancyGuard`, `Pausable`, per-transaction amount cap (`maxSettleAmount`).

**Events:**

```solidity
event SpendSettled(
    address indexed m2Safe,
    address indexed issuerSafe,
    uint256 amount,
    bytes32 indexed lithicTxToken,
    uint256 nonce
);
```

### SafeFactory

Deploys fully-configured M2 Safe bundles in a single transaction using CREATE2 for deterministic addresses.

**Deployment bundle includes:**

- EIP-1167 minimal proxy clone of the Safe singleton
- Full SpendSettler deployment (configured with settler, issuer, USDC addresses)
- Zodiac Roles and Delay modules
- Atomic module enablement via `ModuleSetupHelper` (delegatecall during Safe setup)
- Automatic registration in TenantRegistry

The factory tracks reverse lookups from Safe → module addresses and maintains per-tenant deployment nonces.

### TenantRegistry

On-chain tenant-to-Safe mapping with O(1) lookups.

**Core operations:**

- `registerTenant(tenantId, tenantSafe)` — Owner only
- `registerUser(tenantId, m2Safe)` — Factory only
- `isRegisteredUser(tenantId, m2Safe)` — Constant-time check
- Paginated user listing for off-chain indexing
- Reverse lookup: Safe → tenant ID

### DeFiInteractor

Treasury execution module attached to the M1 Safe. Deliberately constrained to supported protocols only.

**Supported operations:**

- Morpho: `supplyToMorpho()`, `redeemFromMorpho()`
- Aave v3: `supplyToAave()`, `withdrawFromAave()`

**Safety controls:**

- Only the configured `operator` (yield manager service) can execute
- Vaults and pools must be explicitly allowlisted
- ERC-20 approvals are reset to zero after every operation
- Before/after balance snapshots verify actual fund movement

### TreasuryVault

Per-tenant accounting layer over the shared Morpho vault position. This is what makes pooled yield attribution possible.

**Per-tenant tracking:**

```solidity
struct TenantPosition {
    uint256 shares;              // Tenant's share of the vault
    uint256 depositedAmount;     // Total USDC deposited
    uint256 lastDepositTimestamp;
}
```

**Key functions:**

- `depositForTenant(tenantId, amount)` — Deposits USDC, mints proportional shares
- `withdrawForTenant(tenantId, amount)` — Withdraws USDC, burns shares
- `redeemForTenant(tenantId, shares)` — Redeems specific share amount
- `getTenantPosition(tenantId)` — Returns current position

Without this layer, there would be no way to attribute yield from a shared vault back to individual tenants.

---

## Backend Services

The backend is an ESM TypeScript application (`Express 5`, `Prisma 6`, `ioredis`, `viem 2`, `BullMQ 5`). Entry point: `backend/src/server.ts`.

**Startup behavior:**

- Prisma, Redis, and public chain client always start
- Settlement, sweep, and yield jobs only start when `SETTLER_PRIVATE_KEY` is configured
- Lithic and Sumsub fall back to mock clients when credentials are missing (enables local dev/testing)

### Authorization Engine

**File:** `backend/src/services/authorization-engine.ts`

The fastest path in the system. Processes Lithic ASA webhooks and returns APPROVED/DECLINED within **300ms**.

**10-step flow:**

```
Lithic ASA Webhook
       │
       ▼
 1. Event type check (must be AUTHORIZATION)
       │
       ▼
 2. Card lookup (Redis: card:{token} → EOA, M2 Safe, sub-account)
       │
       ▼
 3. Card status check (SubAccount must be "active")
       │
       ▼
 4. KYC status check (User.kycStatus must be "approved")
       │
       ▼
 5. Balance load (Redis cache hit, or rebuild from BalanceLedger)
       │
       ▼
 6. Daily limit check (dailySpent + amount ≤ dailyLimit, 0 = unlimited)
       │
       ▼
 7. Monthly limit check (monthlySpent + amount ≤ monthlyLimit, 0 = unlimited)
       │
       ▼
 8. MCC filter (check against global + per-card blacklist)
       │
       ▼
 9. Atomic Redis spend update (Lua script: balance, daily, monthly)
       │
       ▼
10. Return APPROVED with balance_after
```

**Global MCC blacklist:** 7995 (gambling), 6051 (crypto), 6211 (securities), 6012 (financial), 7801 (casinos), 7802 (racing)

Each step checks the remaining time budget. If the 300ms deadline is about to expire, the engine short-circuits with a DECLINED response. Audit logging is fire-and-forget (async) to avoid blocking.

### Settlement Service

**File:** `backend/src/services/settlement-service.ts`

Processes approved authorizations into on-chain settlements via a BullMQ queue.

**Flow:**

1. **Idempotency check** — Calls `SpendSettler.isSettled(lithicTxToken)` on-chain
2. **Gas estimation** — Estimates gas with progressive bumping per retry: `baseGas × (100 + 20% × (attempt - 1)) / 100`
3. **On-chain submission** — `walletClient.writeContract()` → `SpendSettler.settle(amount, lithicTxToken)`
4. **Wait for confirmation** — `publicClient.waitForTransactionReceipt()`
5. **Record result** — Update Transaction status to `settled` or `failed`, store tx hash

**Concurrency:** 1 (serial processing to avoid nonce collisions)
**Retries:** 3 attempts max, then Transaction marked `failed` with error

### Watcher

**File:** `backend/src/services/watcher.ts`

Indexes on-chain events and keeps the authorization cache synchronized with reality.

**Two loops:**

| Loop               | Interval   | What it does                                                                                                                                                                   |
| ------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Poll**           | 3 seconds  | Fetches new blocks (with 2-block confirmation buffer). Indexes USDC `Transfer` events to known M2 Safes and `SpendSettled` events. Creates BalanceLedger entries for deposits. |
| **Reconciliation** | 60 seconds | Reads on-chain USDC balance for all active M2 Safes. Updates Redis auth cache with fresh balances while preserving spend tracking data.                                        |

**Resilience:** Circuit breaker pauses polling for 30s after 5 consecutive failures. Block cursor persisted in WatcherMeta for crash recovery.

### Sweep Service

**File:** `backend/src/services/sweep-service.ts`

Moves excess USDC from individual M2 Safes to the shared M1 Treasury (Model A tenants only).

**Cycle (every 15 minutes):**

1. Query all active Model A users with M2 Safe addresses
2. Read on-chain USDC balance for each Safe
3. If balance > `SWEEP_THRESHOLD` (default 100 USDC): transfer to M1 Treasury
4. Record BalanceLedger entry (type `sweep`) and audit log

**Health tracking:** Exposes `lastRunAt`, `consecutiveFailures`, `totalSweepsExecuted` for monitoring.

### Yield Manager

**File:** `backend/src/services/yield-manager.ts`

Manages treasury yield across three parallel cycles:

| Cycle                | Interval    | What it does                                                                                                                                             |
| -------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Yield Snapshot**   | 60 seconds  | Reads `TreasuryVault.getTenantPosition()` and Morpho `convertToAssets()` for each tenant. Computes unrealized yield and APY. Writes YieldLedger entries. |
| **Yield Allocation** | On snapshot | Splits realized yield: **60% tenant**, **30% platform**, **10% reserve** (stays in vault). Minimum threshold: 1 USDC to avoid dust.                      |
| **Issuer Top-Up**    | 15 minutes  | Checks issuer safe balance. If below 10,000 USDC, tops up to 50,000 USDC from treasury.                                                                  |

### Webhook Dispatcher

**File:** `backend/src/services/webhook-dispatcher.ts`

Delivers signed event notifications to tenant webhook URLs.

**Signing:** `HMAC-SHA256(secret, timestamp.payload)` → sent as `X-Webhook-Signature` with `X-Webhook-Timestamp`.

**Retry schedule:** 1s → 10s → 60s (3 attempts). Exhausted deliveries logged to AuditLog.

**SSRF protection (validated before saving and dispatching):**

- HTTPS required in production
- Blocked: private IPs (127.x, 10.x, 172.16-31.x, 192.168.x, 169.254.x), loopback (::1), link-local, file:// protocol
- DNS resolution validated

**Current events:** `card.authorization.approved`, `card.authorization.declined`

**Forward-compatible events:** `card.transaction.settled`, `card.transaction.reversed`, `deposit.received`, `withdrawal.initiated`, `withdrawal.completed`, `yield.distributed`

---

## Core Flows

### Flow 1: Card Authorization + Settlement

```
User swipes card
       │
       ▼
Lithic sends ASA webhook ──→ POST /webhooks/lithic/asa
       │
       ▼
HMAC signature verified (raw body + X-Lithic-Signature)
       │
       ▼
AuthorizationEngine.authorize()  ← 10 steps, <300ms
       │
       ├── DECLINED → respond to Lithic, dispatch tenant webhook, done
       │
       └── APPROVED
              │
              ├── Create Transaction record (status: approved)
              ├── Dispatch tenant webhook (card.authorization.approved)
              └── Enqueue settlement job to BullMQ
                     │
                     ▼
              SettlementService picks up job
                     │
                     ▼
              Check SpendSettler.isSettled() → skip if duplicate
                     │
                     ▼
              Call SpendSettler.settle(amount, lithicTxToken)
                     │
                     ▼
              USDC moves: M2 Safe → Issuer Safe (on Base)
                     │
                     ▼
              Transaction.status = "settled", txHash recorded
```

### Flow 2: Deposit Detection

```
User sends USDC to their M2 Safe address
       │
       ▼
Watcher poll loop detects Transfer event (3s interval, 2-block buffer)
       │
       ▼
BalanceLedger entry created (type: deposit)
       │
       ▼
Redis auth cache updated with new balance
       │
       ▼
User's card now has updated spending power
```

### Flow 3: Treasury Sweep + Yield

```
SweepService runs (every 15 min)
       │
       ▼
For each Model A user: check M2 Safe USDC balance
       │
       ├── Below threshold → skip
       └── Above threshold → transfer to M1 Treasury
              │
              ▼
       BalanceLedger entry (type: sweep)

YieldManager runs (continuous)
       │
       ├── Snapshot (60s): read vault positions, compute yield, write YieldLedger
       ├── Allocate: 60% tenant / 30% platform / 10% reserve
       └── Top-up (15min): refill issuer safe if below 10,000 USDC
```

### Flow 4: Tenant Onboarding

```
1. Admin creates tenant
   POST /v1/tenants → returns one-time API key (msk_...)

2. Tenant creates user
   POST /v1/users { externalId, email }

3. User deployed on-chain
   SafeFactory.deploySafeWithModules() → M2 Safe + SpendSettler
   TenantRegistry auto-registration

4. KYC (optional)
   POST /v1/users/:id/kyc/session → Sumsub token
   User completes KYC flow → webhook updates status

5. Card issued
   POST /v1/users/:id/cards → Lithic card created
   Redis card mapping cached for real-time auth

6. User deposits USDC to M2 Safe
   Watcher detects → balance available for card spending
```

---

## Authentication & Security

### API Authentication

Tenants authenticate with an API key sent in `X-API-Key`. The key format is `msk_...`.

**Flow:**

1. Extract raw key from header
2. SHA-256 hash the key
3. Look up Tenant by `apiKeyHash`
4. Reject if tenant status is not `active` (401 for bad key, 403 for suspended)
5. Attach `tenantId` to request — all downstream queries are scoped

**Admin routes** require the resolved tenant to match `ADMIN_TENANT_ID`.

### Rate Limiting

- Tenant API: 1,000 requests/minute (configurable per tenant) via Redis sliding window
- Webhook endpoints: 300 requests/minute per source IP
- Response headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `Retry-After` (on 429)

### Security Properties

| Layer             | Protection                                                          |
| ----------------- | ------------------------------------------------------------------- |
| API keys          | SHA-256 hashed at rest, never stored in plaintext                   |
| Inbound webhooks  | Raw-body HMAC verification (Lithic, Sumsub)                         |
| Outbound webhooks | HMAC-SHA256 signed, SSRF-validated URLs                             |
| Authorization     | Atomic Redis ops prevent double-spend races                         |
| Replay protection | 5-minute dedup key for processed webhook tokens                     |
| Settlement        | On-chain idempotency by Lithic transaction token                    |
| Contracts         | Pausable, access-controlled, reentrancy-guarded                     |
| Treasury          | Before/after balance snapshots, approval resets, vault allowlisting |
| Tenant isolation  | Row-level scoping on every query                                    |

---

## Deployment

### Local Development

```bash
# Start databases
docker compose up -d          # PostgreSQL 16 + Redis 7

# Backend
cd backend && npm install
npx prisma generate
npx prisma migrate dev
npm run dev                   # Express on :3000

# Contracts
cd contracts && forge build
forge test -vv
```

Lithic and Sumsub automatically use mock clients when credentials are absent.

### Production (Kubernetes)

```
k8s/
├── namespace.yaml              # multisubs namespace
├── backend-deployment.yaml     # 2 replicas, rolling update, health probes
├── backend-service.yaml        # ClusterIP on port 3000
├── backend-hpa.yaml            # HPA: 2-10 replicas (CPU 70%, memory 80%)
├── backend-configmap.yaml      # Non-secret environment config
├── backend-secret.yaml         # Secret template (values replaced at deploy)
├── ingress.yaml                # AWS ALB, HTTPS redirect, host: api.multisubs.io
└── db-migration-job.yaml       # Pre-deploy Prisma migration job
```

**CI/CD:** GitHub Actions pipeline builds contracts, backend, SDK, and Docker image. Manual deploy workflow pushes to ECR and rolls out via EKS.

**Chain targets:**

- Test: Base Sepolia (Chain ID 84532)
- Production: Base Mainnet (Chain ID 8453)

### Key Environment Variables

| Group        | Variables                                                                                                                                                         |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server       | `PORT`, `NODE_ENV`, `CORS_ORIGIN`                                                                                                                                 |
| Chain        | `CHAIN_ID`, `BASE_RPC_URL`, contract addresses (`SPEND_SETTLER_ADDRESS`, `MORPHO_VAULT_ADDRESS`, `TREASURY_VAULT_ADDRESS`, `USDC_ADDRESS`, `M1_TREASURY_ADDRESS`) |
| Persistence  | `DATABASE_URL`, `REDIS_URL`                                                                                                                                       |
| Settlement   | `SETTLER_PRIVATE_KEY` (enables settlement/sweep/yield when present), retry count, gas bump %                                                                      |
| Integrations | `LITHIC_API_KEY`, `LITHIC_WEBHOOK_SECRET`, `SUMSUB_APP_TOKEN`, `SUMSUB_SECRET_KEY`                                                                                |
| Operations   | `SWEEP_THRESHOLD`, `SWEEP_INTERVAL_MS`, `YIELD_SNAPSHOT_INTERVAL_MS`, `WATCHER_START_BLOCK`, `WATCHER_POLL_INTERVAL_MS`                                           |
| Admin        | `ADMIN_TENANT_ID`                                                                                                                                                 |

If `SETTLER_PRIVATE_KEY` is missing, the HTTP server still starts — settlement, sweep, and yield jobs are disabled gracefully.
