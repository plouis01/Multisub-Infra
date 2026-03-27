# MultiSubs Infra

Fully custodial crypto-native Banking-as-a-Service platform. Web2 applications integrate a REST API to offer their users USDC deposits with yield, card payments via Lithic, and custody -- all powered by on-chain Safe multisig infrastructure on Base.

## Architecture

```
Tenant App                MultiSubs Platform                    Base Chain
----------    REST API    ------------------                    ----------
           -->  /v1/*  --> Express Backend
                           |
                           +-- AuthorizationEngine (10-step, <300ms)
                           |     Redis cache-first auth
                           +-- SettlementService (BullMQ)
                           |     SpendSettler.settle() ------> M2 Safe --> USDC --> Issuer Safe
                           +-- Watcher (event indexer)    <--- USDC Transfer events
                           +-- YieldManager               <--- Morpho vault position
                           |     30/60/10 allocation
                           +-- SweepService (15min)       ---> M2 --> M1 Treasury
                           +-- LithicClient               <--> Lithic ASA (card auth)
                           +-- SumsubClient               <--> Sumsub (KYC)
```

**Model A (Managed Treasury):** Platform controls M2 Safe funds, sweeps to M1 Treasury, allocates yield.

**Model B (Self-Custody):** User controls funds in their own M2 Safe with per-user Morpho positions.

## Stack

| Layer           | Technology                                     |
| --------------- | ---------------------------------------------- |
| Smart Contracts | Solidity 0.8.24, Foundry, OpenZeppelin, Zodiac |
| Backend         | TypeScript 5.9, Express 5, Prisma, BullMQ      |
| Database        | PostgreSQL 16, Redis 7                         |
| Blockchain      | Base (L2), viem, Safe v1.4.1                   |
| Card Issuer     | Lithic (ASA webhooks)                          |
| KYC             | Sumsub                                         |
| Infra           | Docker, Kubernetes (AWS EKS), GitHub Actions   |

## Smart Contracts

| Contract            | Description                                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `SpendSettler`      | Zodiac module on M2 Safes -- settles card txs by transferring USDC to Issuer Safe. Rolling spend tracking, idempotency, max settle cap.   |
| `SafeFactory`       | CREATE2 factory deploying Safe + SpendSettler + Roles + Delay in one tx. EIP-1167 clones. ModuleSetupHelper for atomic module enablement. |
| `TenantRegistry`    | On-chain tenant -> user -> Safe mapping. O(1) lookups, factory-only registration, paginated views.                                        |
| `DeFiInteractor`    | M1 Treasury module for Morpho vault + Aave v3 operations. Vault allowlist, balance snapshots, approval resets.                            |
| `TreasuryVault`     | Per-tenant ERC-4626 share accounting over Morpho vault. Yield snapshots, loss-scenario redemption, migration protection.                  |
| `ModuleSetupHelper` | Stateless helper for atomic module enablement via Safe delegatecall during setup.                                                         |

## Quick Start

### Prerequisites

- [Foundry](https://book.getfoundry.sh/getting-started/installation)
- Node.js 20+
- Docker & Docker Compose

### Local Development

```bash
# 1. Start PostgreSQL + Redis
docker compose up -d

# 2. Install dependencies
cd backend && npm install && npx prisma generate && npx prisma db push
cd ../sdk && npm install

# 3. Copy environment config
cp .env.example .env

# 4. Run the backend
cd backend && npm run dev
```

### Running Tests

```bash
# Smart contracts (283 tests)
cd contracts && forge test -vv

# Backend (203 tests)
cd backend && npm test

# Type checks
cd backend && npx tsc --noEmit
cd sdk && npx tsc --noEmit

# Everything
cd contracts && forge test && cd ../backend && npm test
```

### Contract Deployment

```bash
# Testnet (deploys mocks + full infra + test settlement)
cd contracts
forge script script/DeployTestnet.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast

# Mainnet (requires pre-deployed M1 Safe + env vars configured)
forge script script/DeployAll.s.sol --rpc-url $BASE_MAINNET_RPC_URL --broadcast --verify

# Verify on Basescan
forge script script/VerifyContracts.s.sol
```

## API

Full OpenAPI spec: [`backend/openapi.yaml`](backend/openapi.yaml)

Postman collection: [`backend/postman.json`](backend/postman.json)

### Key Endpoints

| Method | Path                        | Description                               |
| ------ | --------------------------- | ----------------------------------------- |
| POST   | `/v1/users`                 | Create user                               |
| POST   | `/v1/users/:id/cards`       | Issue card (virtual/physical)             |
| POST   | `/v1/users/:id/kyc/session` | Start KYC verification                    |
| GET    | `/v1/transactions`          | List transactions (paginated, filterable) |
| GET    | `/v1/yield/summary`         | Tenant yield summary                      |
| POST   | `/v1/tenants`               | Create tenant (admin)                     |
| POST   | `/webhooks/lithic/asa`      | Lithic card authorization                 |
| GET    | `/v1/admin/dashboard`       | Platform overview (admin)                 |
| GET    | `/health`                   | System health check                       |

Authentication: `X-API-Key` header with tenant API key.

## SDK

```typescript
import { MultiSubsClient, verifyWebhookWithTimestamp } from "@multisubs/sdk";

const client = new MultiSubsClient({
  apiKey: "msk_...",
  baseUrl: "https://api.multisubs.io",
});

// Create user + issue card
const user = await client.users.create({ externalId: "user-123" });
const card = await client.cards.issue(user.id, {
  type: "virtual",
  dailyLimit: 50000,
  monthlyLimit: 500000,
});

// Verify incoming webhook
const isValid = verifyWebhookWithTimestamp(
  rawBody,
  req.headers["x-webhook-signature"],
  webhookSecret,
  req.headers["x-webhook-timestamp"],
);
```

## Project Structure

```
contracts/
  src/                    # Solidity contracts
  test/                   # Foundry tests (283 tests)
  script/                 # Deployment scripts (DeployAll, DeployTestnet, Verify)
backend/
  src/
    server.ts             # Express entry point
    services/             # AuthorizationEngine, SettlementService, Watcher,
                          # YieldManager, SweepService, WebhookDispatcher
    integrations/         # Lithic, Sumsub (KYC)
    routes/               # REST API (users, cards, transactions, yield,
                          # tenants, admin, webhooks, kyc, health)
    middleware/            # Auth (API key), rate limiting
    lib/                  # Redis (atomic Lua scripts), blockchain (viem)
  prisma/schema.prisma    # 10 data models
  test/                   # Vitest tests (203 tests)
  openapi.yaml            # OpenAPI 3.0 spec
  postman.json            # Postman collection
  Dockerfile              # Multi-stage production build
sdk/
  src/                    # @multisubs/sdk TypeScript client
k8s/                      # Kubernetes manifests (EKS)
.github/workflows/        # CI + Deploy pipelines
```

## Security

Three security review passes completed. Key hardening measures:

**Smart Contracts:**

- Two-step ownership transfer (Module.sol + Ownable2Step)
- Balance snapshot pattern (before/after) for all DeFi operations
- Circular buffer for spend history (bounded storage)
- Approval reset after every deposit/supply
- MaxSettleAmount cap, idempotency on Lithic tokens
- ModuleSetupHelper for atomic module enablement via delegatecall

**Backend:**

- Redis Lua script for atomic authorization (no TOCTOU race)
- Webhook replay protection (Redis dedup, 5min TTL)
- SSRF protection on webhook URLs (private IP blocking, HTTPS enforcement)
- Raw body buffer for HMAC verification
- Rate limiting on all endpoints (API key + webhook IP-based)
- Zod validation on all inputs

## License

CONFIDENTIAL -- DUSA LABS SAS
