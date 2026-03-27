# MultiSubs Backend

TypeScript/Express backend for the MultiSubs BaaS platform. Handles card authorization, on-chain settlement, yield management, and multi-tenant API access.

## Services

| Service                 | Description                                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **AuthorizationEngine** | 10-step card authorization check (<300ms SLA). Redis cache-first with atomic Lua script for spend updates.                       |
| **SettlementService**   | BullMQ queue processing card settlements. Calls SpendSettler.settle() on-chain. 3x retry with gas bumps, idempotency.            |
| **Watcher**             | Base chain event indexer. Tracks USDC deposits + SpendSettled events. 60s reconciliation cycle. Circuit breaker on RPC failures. |
| **YieldManager**        | Morpho vault yield snapshots (4h), 30/60/10 allocation (platform/tenant/reserve), Platform Issuer Safe top-up.                   |
| **SweepService**        | Sweeps USDC from M2 Safes to M1 Treasury every 15 min when balance exceeds $100 threshold.                                       |
| **WebhookDispatcher**   | Dispatches events to tenants with HMAC-SHA256 signatures. 3x retry (1s/10s/60s), dead letter to AuditLog.                        |
| **LithicClient**        | Card issuance + ASA webhook handling. MockLithicClient for dev/CI.                                                               |
| **SumsubClient**        | KYC verification sessions + webhook handling. MockSumsubClient for dev/CI.                                                       |

## Quick Start

```bash
# Prerequisites: Docker running for PostgreSQL + Redis
docker compose -f ../docker-compose.yml up -d

# Install
npm install

# Generate Prisma client
npx prisma generate

# Push schema to database
npx prisma db push

# Copy environment config
cp ../.env.example ../.env

# Start in dev mode (hot reload)
npm run dev
```

## Scripts

| Command                  | Description                       |
| ------------------------ | --------------------------------- |
| `npm run dev`            | Start with hot reload (tsx watch) |
| `npm start`              | Start production build            |
| `npm run build`          | Compile TypeScript                |
| `npm test`               | Run tests (203 tests)             |
| `npm run test:watch`     | Run tests in watch mode           |
| `npm run test:coverage`  | Run tests with coverage           |
| `npm run lint`           | Type check (tsc --noEmit)         |
| `npx prisma generate`    | Generate Prisma client            |
| `npx prisma migrate dev` | Run migrations (dev)              |
| `npx prisma db push`     | Push schema to DB                 |

## API Endpoints

Full spec: [`openapi.yaml`](openapi.yaml) | Postman: [`postman.json`](postman.json)

### Public

| Method | Path                   | Description                               |
| ------ | ---------------------- | ----------------------------------------- |
| GET    | `/health`              | System health (DB, Redis, Watcher status) |
| POST   | `/webhooks/lithic/asa` | Lithic ASA card authorization (HMAC auth) |
| POST   | `/webhooks/sumsub`     | Sumsub KYC webhook (HMAC auth)            |

### Authenticated (`X-API-Key` header)

| Method | Path                            | Description                               |
| ------ | ------------------------------- | ----------------------------------------- |
| POST   | `/v1/users`                     | Create user                               |
| GET    | `/v1/users/:id`                 | Get user details                          |
| GET    | `/v1/users/:id/balance`         | Get user balance + spend totals           |
| POST   | `/v1/users/:userId/cards`       | Issue card (virtual/physical)             |
| GET    | `/v1/users/:userId/cards`       | List user's cards                         |
| PATCH  | `/v1/cards/:cardId`             | Update card (freeze/unfreeze/limits)      |
| POST   | `/v1/users/:userId/kyc/session` | Create KYC verification session           |
| GET    | `/v1/users/:userId/kyc/status`  | Get KYC status                            |
| GET    | `/v1/transactions`              | List transactions (filterable, paginated) |
| GET    | `/v1/transactions/:id`          | Get transaction details                   |
| GET    | `/v1/yield/summary`             | Tenant yield summary                      |
| GET    | `/v1/yield/snapshots`           | Yield snapshot history (paginated)        |

### Admin (`X-API-Key` must match `ADMIN_TENANT_ID`)

| Method | Path                         | Description                     |
| ------ | ---------------------------- | ------------------------------- |
| POST   | `/v1/tenants`                | Create tenant (returns API key) |
| GET    | `/v1/tenants/:id`            | Get tenant details              |
| PATCH  | `/v1/tenants/:id`            | Update tenant                   |
| POST   | `/v1/tenants/:id/rotate-key` | Rotate API key                  |
| GET    | `/v1/admin/dashboard`        | Multi-tenant overview           |
| GET    | `/v1/admin/treasury`         | M1 Treasury health              |
| GET    | `/v1/admin/settlement-queue` | Settlement queue status         |
| GET    | `/v1/admin/tenants/metrics`  | Per-tenant metrics              |

## Database

10 Prisma models with `tenantId` FK for row-level isolation:

```
Tenant ──< User ──< SubAccount
              |──< Transaction
              |──< BalanceLedger
YieldLedger
WatcherMeta
SpendSettledEvent
AuditLog
```

## Testing

203 tests across 6 test files:

| Suite                | Tests | Description                                                     |
| -------------------- | ----- | --------------------------------------------------------------- |
| authorization-engine | 30    | 10-step auth flow, decline paths, atomic updates, cache rebuild |
| lithic               | 42    | Card CRUD, HMAC verification, ASA event parsing                 |
| webhook-dispatcher   | 16    | Dispatch, retry, dead letter, SSRF protection                   |
| redis                | 28    | Auth cache, card mapping, rate limiting, atomic Lua spend       |
| yield-manager        | 46    | Sweep, snapshots, 30/60/10 allocation, issuer top-up            |
| kyc                  | 41    | Applicant CRUD, access tokens, webhook verification             |

All tests run without live DB/Redis -- fully mocked.

## Configuration

All config via environment variables, validated with Zod at startup. See `../.env.example` for the full list.

Key variables:

| Variable           | Description                              | Default                                                     |
| ------------------ | ---------------------------------------- | ----------------------------------------------------------- |
| `PORT`             | Server port                              | `3000`                                                      |
| `DATABASE_URL`     | PostgreSQL connection                    | `postgresql://multisubs:multisubs@localhost:5432/multisubs` |
| `REDIS_URL`        | Redis connection                         | `redis://localhost:6379`                                    |
| `CHAIN_ID`         | Base chain (84532=Sepolia, 8453=Mainnet) | `84532`                                                     |
| `LITHIC_API_KEY`   | Lithic API key (empty = mock)            | ``                                                          |
| `SUMSUB_APP_TOKEN` | Sumsub token (empty = mock)              | ``                                                          |
| `ADMIN_TENANT_ID`  | Admin tenant for privileged endpoints    | `__unset__`                                                 |

## Docker

```bash
# Build
docker build -t multisubs-backend .

# Run
docker run -p 3000:3000 --env-file ../.env multisubs-backend
```

Multi-stage build: 20-alpine base, non-root user, healthcheck on `/health`.

## Security

- Atomic Redis Lua script for authorization (no double-spend race)
- Webhook replay protection (Redis dedup key, 5min TTL)
- SSRF protection on tenant webhook URLs (private IP blocking, HTTPS enforcement in prod)
- Raw body buffer capture for HMAC verification (not re-serialized JSON)
- Rate limiting: 1000 req/min per tenant (API key), 300 req/min per IP (webhooks)
- Zod validation on all request bodies and route parameters
- Dev auth bypass requires explicit `ALLOW_TEST_AUTH=true` + non-production env + DB-verified tenant
