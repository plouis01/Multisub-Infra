# MultiSubs Integration Guide

This guide is for engineering teams at web2 companies integrating MultiSubs into their product. By the end, you'll have users with USDC custody accounts, cards, real-time balance tracking, and webhook-driven event processing — all through a REST API.

---

## How Integration Works

Your company owns the user experience — signup, login, UI, support, notifications. MultiSubs owns the financial infrastructure — custody, cards, authorization, settlement, treasury, and yield.

```
┌──────────────┐         ┌───────────────────┐         ┌──────────────┐
│   Your App   │         │   Your Backend    │         │  MultiSubs   │
│  (Frontend)  │────────▶│                   │────────▶│     API      │
│              │         │  • User mapping   │  REST   │              │
│              │         │  • Secret storage │  API    │  • Custody   │
│              │         │  • Webhook handler│◀────────│  • Cards     │
│              │         │  • Local state    │ Webhooks│  • Settlement│
└──────────────┘         └───────────────────┘         └──────────────┘
```

**Never expose your MultiSubs API key in browser or mobile code.** All API calls go server-to-server from your backend.

---

## Quick Start

### 1. Get Your Credentials

You'll receive from MultiSubs:

- **API key** (`msk_...`) — authenticates all API calls
- **Base URL** — `https://api.multisubs.io` (production) or sandbox equivalent
- **Webhook secret** — for verifying inbound webhook signatures
- **Webhook URL** — your endpoint where MultiSubs sends events

Store the API key and webhook secret in your secret manager. Never commit them to source control.

### 2. Install the SDK

```bash
npm install @multisubs/sdk
```

```typescript
import { MultiSubsClient } from "@multisubs/sdk";

const multisubs = new MultiSubsClient({
  apiKey: process.env.MULTISUBS_API_KEY!,
  baseUrl: process.env.MULTISUBS_BASE_URL, // optional, defaults to production
  timeout: 30000, // optional, defaults to 30s
});
```

Or call the REST API directly with any HTTP client — the SDK is a convenience wrapper.

### 3. Authentication

Every request to `/v1/*` requires your API key in the `X-API-Key` header:

```bash
curl -H "X-API-Key: msk_your_key_here" \
     https://api.multisubs.io/v1/users
```

Responses use standard HTTP status codes:

- `401` — Invalid or missing API key
- `403` — Tenant suspended or disabled
- `429` — Rate limited (check `Retry-After` header)

**Rate limit:** 1,000 requests/minute per tenant. Response headers include `X-RateLimit-Limit` and `X-RateLimit-Remaining`.

---

## Step-by-Step Integration

### Step 1: Create Users

When a user in your app becomes eligible for financial features, create a corresponding MultiSubs user:

```typescript
// SDK
const user = await multisubs.users.create({
  externalId: "your-internal-user-id-123", // your canonical user ID
  email: "user@example.com", // optional
});

// Store the mapping
await db.userFinancialProfile.create({
  data: {
    appUserId: "your-internal-user-id-123",
    multisubsUserId: user.id,
  },
});
```

```bash
# REST
POST /v1/users
Content-Type: application/json
X-API-Key: msk_...

{
  "externalId": "your-internal-user-id-123",
  "email": "user@example.com"
}
```

**Response:**

```json
{
  "id": "uuid",
  "tenantId": "uuid",
  "externalId": "your-internal-user-id-123",
  "email": "user@example.com",
  "kycStatus": "pending",
  "m2SafeAddress": null,
  "eoaAddress": null,
  "status": "active",
  "createdAt": "2026-01-15T10:00:00.000Z"
}
```

**Recommended local table:**

| Column              | Purpose                             |
| ------------------- | ----------------------------------- |
| `app_user_id`       | Your primary key                    |
| `multisubs_user_id` | Returned by POST /v1/users          |
| `multisubs_status`  | Local cache of active/frozen/closed |
| `kyc_status`        | Local mirror of KYC state           |
| `created_at`        | Audit and reconciliation            |

Use your `app_user_id` as the `externalId` — it becomes the join key between systems.

### Step 2: KYC

MultiSubs handles KYC through Sumsub. Your app controls when and how the KYC flow is presented.

**Backend:**

```typescript
// Create a KYC session
const session = await multisubs.users.createKycSession(user.id);
// Returns: { applicantId, token, userId }

// Pass session.token to your frontend
```

**Frontend:**

Use the Sumsub Web SDK with the token from your backend:

```typescript
import snsWebSdk from "@sumsub/websdk";

const snsWebSdkInstance = snsWebSdk
  .init(accessToken, () => {
    // Token refresh callback — call your backend for a new token
    return fetch("/api/kyc/refresh-token")
      .then((r) => r.json())
      .then((d) => d.token);
  })
  .withConf({ lang: "en" })
  .on("onError", (error) => console.error("KYC error:", error))
  .build();

snsWebSdkInstance.launch("#kyc-container");
```

**Check status:**

```typescript
// SDK
const status = await multisubs.users.getKycStatus(user.id);

// REST
GET /v1/users/:userId/kyc/status
```

**Gate card issuance on KYC approval.** The authorization engine will decline transactions for users without `kycStatus: "approved"`.

### Step 3: Issue Cards

Once a user passes KYC:

```typescript
// SDK
const card = await multisubs.cards.issue(user.id, {
  type: "virtual", // "virtual" or "physical"
  dailyLimit: 50000, // $500.00 in cents
  monthlyLimit: 500000, // $5,000.00 in cents
  mccBlacklist: ["7995"], // optional: block gambling
});
```

```bash
# REST
POST /v1/users/:userId/cards
Content-Type: application/json
X-API-Key: msk_...

{
  "type": "virtual",
  "dailyLimit": 50000,
  "monthlyLimit": 500000,
  "mccBlacklist": ["7995"]
}
```

**Response includes** the SubAccount record with card details. Store the card ID for future operations.

**Card management:**

```typescript
// Freeze a card
await multisubs.cards.update(cardId, { action: "freeze" });

// Unfreeze
await multisubs.cards.update(cardId, { action: "unfreeze" });

// Cancel permanently
await multisubs.cards.update(cardId, { action: "cancel" });

// Update limits
await multisubs.cards.update(cardId, {
  dailyLimit: 100000, // $1,000.00
  monthlyLimit: 1000000, // $10,000.00
});

// Update MCC blacklist
await multisubs.cards.update(cardId, {
  mccBlacklist: ["7995", "6051"],
});
```

```bash
# REST
PATCH /v1/cards/:cardId
Content-Type: application/json
X-API-Key: msk_...

{
  "action": "freeze"
}
```

**Limits are in cents.** Setting a limit to `0` means unlimited.

### Step 4: Balances & Funding

Users fund their account by sending USDC to their M2 Safe address on Base. The Watcher service detects deposits automatically and updates the spendable balance.

**Check balance:**

```typescript
// SDK
const balance = await multisubs.users.getBalance(user.id);
```

```bash
# REST
GET /v1/users/:id/balance
X-API-Key: msk_...
```

**Response:**

```json
{
  "userId": "uuid",
  "usdcBalance": "5000000000",
  "dailySpent": "50000000",
  "monthlySpent": "150000000",
  "lastUpdated": 1711900000000
}
```

**Amount handling — critical:**

- All balance values are **USDC 6-decimal strings** (e.g., `"1000000"` = 1.00 USDC)
- **Never convert money through floating point.** Use BigInt or a decimal library.
- Display conversion: divide by 1,000,000 for USDC, divide by 100 for cents

**UX note:** Tell users that balances may lag briefly after a deposit (the Watcher polls every 3 seconds with a 2-block confirmation buffer).

### Step 5: Transactions

```typescript
// List transactions (paginated)
const txs = await multisubs.transactions.list({
  limit: 50,
  offset: 0,
  status: "settled", // optional filter: pending, approved, declined, settled, reversed, failed
  type: "authorization", // optional filter: authorization, settlement, reversal, deposit, withdrawal
});

// Get single transaction
const tx = await multisubs.transactions.get(transactionId);
```

```bash
# REST
GET /v1/transactions?limit=50&offset=0&status=settled
GET /v1/transactions/:id
X-API-Key: msk_...
```

**Response (single transaction):**

```json
{
  "id": "uuid",
  "tenantId": "uuid",
  "userId": "uuid",
  "subAccountId": "uuid",
  "lithicTxToken": "tok_...",
  "type": "authorization",
  "amount": 2500,
  "currency": "USD",
  "merchantName": "Coffee Shop",
  "merchantMcc": "5812",
  "status": "settled",
  "onChainTxHash": "0xabc...",
  "createdAt": "2026-01-15T14:30:00.000Z"
}
```

**Build your activity feed from your own database**, not live API fetches. Ingest MultiSubs data via webhooks and periodic API sync. Use the API for backfill, support tooling, and reconciliation.

### Step 6: Yield

For Model A tenants, MultiSubs manages treasury yield automatically. Your app can display yield data to users.

```typescript
// Tenant yield summary (latest snapshot)
const summary = await multisubs.yield.summary();

// Historical snapshots (paginated)
const snapshots = await multisubs.yield.snapshots({ limit: 30 });
```

```bash
# REST
GET /v1/yield/summary
GET /v1/yield/snapshots?limit=30
X-API-Key: msk_...
```

**Yield allocation:** 60% to tenant, 30% to platform, 10% stays as reserve in the vault.

---

## Webhooks

MultiSubs sends signed HTTP POST requests to your webhook URL when events occur. This is how your app stays in sync in real time.

### Current Events

| Event                         | When                            |
| ----------------------------- | ------------------------------- |
| `card.authorization.approved` | A card transaction was approved |
| `card.authorization.declined` | A card transaction was declined |

### Future Events (forward-compatible)

| Event                       | When                          |
| --------------------------- | ----------------------------- |
| `card.transaction.settled`  | On-chain settlement completed |
| `card.transaction.reversed` | Transaction reversed          |
| `deposit.received`          | USDC deposited to user's Safe |
| `withdrawal.initiated`      | Withdrawal started            |
| `withdrawal.completed`      | Withdrawal confirmed          |
| `yield.distributed`         | Yield allocated to tenant     |

### Webhook Payload

```json
{
  "id": "evt_uuid",
  "type": "card.authorization.approved",
  "tenantId": "uuid",
  "timestamp": 1711900000000,
  "data": {
    "lithicTxToken": "tok_...",
    "cardToken": "card_...",
    "amount": 2500,
    "merchant": {
      "name": "Coffee Shop",
      "mcc": "5812"
    },
    "approved": true,
    "balanceAfter": "4997500000"
  }
}
```

### Signature Verification

Every webhook includes two headers:

- `X-Webhook-Signature` — HMAC-SHA256 signature
- `X-Webhook-Timestamp` — Unix timestamp (ms)

**Signature is computed as:** `HMAC-SHA256(secret, timestamp + "." + rawBody)`

**Using the SDK (recommended):**

```typescript
import {
  verifyAndParseWebhook,
  verifyWebhookWithTimestamp,
} from "@multisubs/sdk";

// Option 1: Verify + parse in one step
app.post(
  "/webhooks/multisubs",
  express.raw({ type: "application/json" }),
  (req, res) => {
    try {
      const event = verifyAndParseWebhook(
        req.body.toString(), // raw body string
        req.headers["x-webhook-signature"] as string,
        process.env.MULTISUBS_WEBHOOK_SECRET!,
        req.headers["x-webhook-timestamp"] as string,
      );

      // Process the event
      await processWebhookEvent(event);
      res.sendStatus(200);
    } catch (err) {
      res.sendStatus(401);
    }
  },
);

// Option 2: Verify with staleness check (reject events older than 5 minutes)
const isValid = verifyWebhookWithTimestamp(
  rawBody,
  signature,
  secret,
  timestamp,
  300, // maxAgeSeconds, default 300
);
```

**Manual verification:**

```typescript
import { createHmac } from "crypto";

function verifyWebhook(
  rawBody: string,
  signature: string,
  secret: string,
  timestamp: string,
): boolean {
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
```

### Webhook Handler Best Practices

```typescript
app.post(
  "/webhooks/multisubs",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    // 1. Verify signature BEFORE parsing
    const event = verifyAndParseWebhook(
      req.body.toString(),
      req.headers["x-webhook-signature"] as string,
      process.env.MULTISUBS_WEBHOOK_SECRET!,
      req.headers["x-webhook-timestamp"] as string,
    );

    // 2. Idempotency: check if already processed
    const exists = await db.webhookEvent.findUnique({
      where: { eventId: event.id },
    });
    if (exists) {
      return res.sendStatus(200); // Already processed, return 200
    }

    // 3. Persist the event
    await db.webhookEvent.create({
      data: {
        eventId: event.id,
        type: event.type,
        payload: event,
        processedAt: new Date(),
      },
    });

    // 4. Update local state
    if (event.type === "card.authorization.approved") {
      await updateUserBalance(event.data);
      await createActivityFeedEntry(event.data);
    }

    // 5. Enqueue async side effects (notifications, etc.)
    await notificationQueue.add("card-activity", {
      userId: event.data.userId,
      type: event.type,
    });

    // 6. Return 200 quickly — don't block on long-running work
    res.sendStatus(200);
  },
);
```

**Key rules:**

- Keep the raw body for signature verification — don't re-serialize
- Make processing idempotent (MultiSubs retries on failure: 1s, 10s, 60s)
- Return 200 as fast as possible
- Enqueue heavy work instead of doing it inline

---

## Full API Reference

### Users

| Method | Endpoint                | Description                       |
| ------ | ----------------------- | --------------------------------- |
| `POST` | `/v1/users`             | Create a user                     |
| `GET`  | `/v1/users/:id`         | Get user details                  |
| `GET`  | `/v1/users/:id/balance` | Get USDC balance + spend tracking |

**POST /v1/users**

```json
// Request
{ "externalId": "string", "email": "string (optional)" }

// Response
{
  "id": "uuid", "tenantId": "uuid", "externalId": "string",
  "email": "string", "kycStatus": "pending",
  "m2SafeAddress": null, "eoaAddress": null,
  "status": "active", "createdAt": "ISO8601"
}
```

### Cards

| Method  | Endpoint                  | Description                                 |
| ------- | ------------------------- | ------------------------------------------- |
| `POST`  | `/v1/users/:userId/cards` | Issue a new card                            |
| `GET`   | `/v1/users/:userId/cards` | List user's cards                           |
| `PATCH` | `/v1/cards/:cardId`       | Update card (freeze/unfreeze/cancel/limits) |

**POST /v1/users/:userId/cards**

```json
// Request
{
  "type": "virtual | physical",
  "dailyLimit": 50000, // cents
  "monthlyLimit": 500000, // cents
  "mccBlacklist": ["7995"] // optional
}
```

**PATCH /v1/cards/:cardId**

```json
// Freeze
{ "action": "freeze" }

// Update limits
{ "dailyLimit": 100000, "monthlyLimit": 1000000 }

// Update MCC blacklist
{ "mccBlacklist": ["7995", "6051"] }
```

### KYC

| Method | Endpoint                        | Description                               |
| ------ | ------------------------------- | ----------------------------------------- |
| `POST` | `/v1/users/:userId/kyc/session` | Create KYC session (returns Sumsub token) |
| `GET`  | `/v1/users/:userId/kyc/status`  | Get current KYC status                    |

### Transactions

| Method | Endpoint               | Description                               |
| ------ | ---------------------- | ----------------------------------------- |
| `GET`  | `/v1/transactions`     | List transactions (paginated, filterable) |
| `GET`  | `/v1/transactions/:id` | Get transaction details                   |

**Query parameters for GET /v1/transactions:**

- `limit` — Page size (default: 50)
- `offset` — Skip N records
- `status` — Filter: `pending`, `approved`, `declined`, `settled`, `reversed`, `failed`
- `type` — Filter: `authorization`, `settlement`, `reversal`, `deposit`, `withdrawal`

### Yield

| Method | Endpoint              | Description                            |
| ------ | --------------------- | -------------------------------------- |
| `GET`  | `/v1/yield/summary`   | Latest yield snapshot for tenant       |
| `GET`  | `/v1/yield/snapshots` | Historical yield snapshots (paginated) |

### Tenant Management (Admin)

These endpoints require the admin tenant API key.

| Method  | Endpoint                     | Description                                        |
| ------- | ---------------------------- | -------------------------------------------------- |
| `POST`  | `/v1/tenants`                | Create a new tenant (returns one-time API key)     |
| `GET`   | `/v1/tenants/:id`            | Get tenant details                                 |
| `PATCH` | `/v1/tenants/:id`            | Update tenant (status, rate limit, webhook config) |
| `POST`  | `/v1/tenants/:id/rotate-key` | Rotate API key                                     |
| `GET`   | `/v1/admin/dashboard`        | Platform aggregate metrics                         |

### Public Endpoints (No Auth)

| Method | Endpoint               | Description                                  |
| ------ | ---------------------- | -------------------------------------------- |
| `GET`  | `/health`              | System health check                          |
| `POST` | `/webhooks/lithic/asa` | Lithic authorization webhook (HMAC verified) |
| `POST` | `/webhooks/sumsub`     | Sumsub KYC webhook (HMAC verified)           |

---

## SDK Reference

### Initialization

```typescript
import { MultiSubsClient } from "@multisubs/sdk";

const client = new MultiSubsClient({
  apiKey: "msk_...",
  baseUrl: "https://api.multisubs.io", // optional
  timeout: 30000, // optional, ms
});
```

### Resource Namespaces

```typescript
// Users
client.users.create({ externalId, email? })
client.users.get(userId)
client.users.getBalance(userId)

// Cards
client.cards.issue(userId, { type, dailyLimit, monthlyLimit, mccBlacklist? })
client.cards.list(userId)
client.cards.update(cardId, { action?, dailyLimit?, monthlyLimit?, mccBlacklist? })

// Transactions
client.transactions.list({ limit?, offset?, status?, type? })
client.transactions.get(transactionId)

// Yield
client.yield.summary()
client.yield.snapshots({ limit?, offset? })

// Tenants (admin only)
client.tenants.create({ name, custodyModel, webhookUrl?, rateLimit? })
client.tenants.get(tenantId)
client.tenants.update(tenantId, { ... })
client.tenants.rotateKey(tenantId)
```

### Webhook Helpers

```typescript
import {
  verifyWebhook,
  verifyWebhookWithTimestamp,
  verifyAndParseWebhook,
} from "@multisubs/sdk";

// Basic verification (returns boolean)
verifyWebhook(rawBody, signature, secret, timestamp?)

// With staleness check (rejects events older than maxAgeSeconds)
verifyWebhookWithTimestamp(rawBody, signature, secret, timestamp, maxAgeSeconds = 300)

// Verify + parse in one step (throws on failure)
verifyAndParseWebhook(rawBody, signature, secret, timestamp?)
```

---

## Integration Checklist

### Milestone 1: Foundation

- [ ] Store API key and webhook secret in secret manager
- [ ] Initialize SDK or HTTP client with correct base URL
- [ ] Create user mapping table in your database
- [ ] Wire `POST /v1/users` into your user onboarding flow
- [ ] Test user creation in sandbox

### Milestone 2: KYC + Cards

- [ ] Wire `POST /v1/users/:userId/kyc/session` to get Sumsub tokens
- [ ] Integrate Sumsub Web SDK in your frontend
- [ ] Poll or webhook for KYC approval
- [ ] Gate card issuance on approved KYC
- [ ] Wire `POST /v1/users/:userId/cards` for card issuance
- [ ] Implement card freeze/unfreeze/cancel in your admin tools

### Milestone 3: Live Data

- [ ] Display balances from `GET /v1/users/:id/balance`
- [ ] Build transaction history from `GET /v1/transactions`
- [ ] Show yield data from `GET /v1/yield/summary` (if applicable)
- [ ] Implement amount display (USDC 6-decimal → human readable)

### Milestone 4: Webhooks

- [ ] Deploy webhook endpoint with `express.raw()` body parsing
- [ ] Implement HMAC signature verification
- [ ] Add idempotency check (deduplicate by event ID)
- [ ] Persist events before processing
- [ ] Update local state on authorization events
- [ ] Enqueue notifications as async side effects
- [ ] Return 200 within a few hundred ms

### Milestone 5: Production

- [ ] Switch to production API key and base URL
- [ ] Update webhook URL to production endpoint
- [ ] Verify rate limits are appropriate for your traffic
- [ ] Set up monitoring for webhook delivery failures
- [ ] Build support tooling for transaction lookup and card management
- [ ] Run full end-to-end test (create user → KYC → card → fund → spend → settle)
- [ ] Decide how your product explains "pending" vs "settled" transactions to users

---

## Important Conventions

### Money: Two Unit Systems

MultiSubs uses two different amount systems — mixing them up is the most common integration bug:

| Context                                    | Unit               | Example                     |
| ------------------------------------------ | ------------------ | --------------------------- |
| Card limits (`dailyLimit`, `monthlyLimit`) | **Cents**          | `50000` = $500.00           |
| Card authorization amounts                 | **Cents**          | `2500` = $25.00             |
| Balance, ledger, treasury amounts          | **USDC 6-decimal** | `"500000000"` = 500.00 USDC |

**Never use floating point for money.** Use BigInt or a decimal library.

### Pagination

List endpoints support `limit` and `offset` query parameters. Default page size is typically 50.

### Error Responses

```json
{
  "error": "Description of what went wrong"
}
```

| Status | Meaning                                                |
| ------ | ------------------------------------------------------ |
| 400    | Bad request (validation failure)                       |
| 401    | Invalid or missing API key                             |
| 403    | Tenant suspended/disabled, or insufficient permissions |
| 404    | Resource not found                                     |
| 429    | Rate limited — check `Retry-After` header              |
| 500    | Server error                                           |

### Test Mode

In sandbox/development, set `ALLOW_TEST_AUTH=true` to use `X-Test-Tenant-Id` header as an auth bypass. This is for development only — never enabled in production.
