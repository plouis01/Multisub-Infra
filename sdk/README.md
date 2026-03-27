# @multisubs/sdk

TypeScript SDK for the MultiSubs BaaS platform. Wraps the REST API with typed methods and provides webhook verification helpers.

## Installation

```bash
npm install @multisubs/sdk
```

## Quick Start

```typescript
import { MultiSubsClient } from "@multisubs/sdk";

const client = new MultiSubsClient({
  apiKey: "msk_your_api_key_here",
  baseUrl: "https://api.multisubs.io", // optional, defaults to this
});

// Create a user
const user = await client.users.create({
  externalId: "user-123",
  email: "user@example.com",
});

// Issue a virtual card
const card = await client.cards.issue(user.id, {
  type: "virtual",
  dailyLimit: 50000, // $500.00 in cents
  monthlyLimit: 500000, // $5,000.00 in cents
});

// Check balance
const balance = await client.users.getBalance(user.id);
console.log(`USDC balance: ${balance.usdcBalance}`);
```

## API Reference

### Users

```typescript
// Create user
const user = await client.users.create({
  externalId: "your-user-id",
  email: "user@example.com", // optional
  kycStatus: "pending", // optional, default "pending"
});

// Get user
const user = await client.users.get("user_id");

// Get balance
const balance = await client.users.getBalance("user_id");
// { usdcBalance: "1000000", dailySpent: "0", monthlySpent: "0", ... }
```

### Cards

```typescript
// Issue card
const card = await client.cards.issue("user_id", {
  type: "virtual", // "virtual" or "physical"
  dailyLimit: 50000, // cents
  monthlyLimit: 500000, // cents
  mccBlacklist: ["7995"], // optional, block gambling
});

// List cards
const cards = await client.cards.list("user_id");

// Update card (freeze, unfreeze, update limits)
const updated = await client.cards.update("card_id", {
  action: "freeze",
});
```

### Transactions

```typescript
// List transactions (paginated, filterable)
const result = await client.transactions.list({
  limit: 50,
  offset: 0,
  status: "settled", // optional filter
  type: "authorization", // optional filter
});
// { items: [...], total: 150, limit: 50, offset: 0 }

// Get single transaction
const tx = await client.transactions.get("tx_id");
```

### Yield

```typescript
// Get yield summary
const summary = await client.yield.summary();
// { totalDeposited: "1000000", unrealizedYield: "50000", apyBps: 500, ... }

// List yield snapshots
const snapshots = await client.yield.snapshots({ limit: 10 });
```

### Tenants (Admin)

```typescript
// Create tenant (returns API key -- save it, shown only once)
const tenant = await client.tenants.create({
  name: "Acme Corp",
  custodyModel: "MODEL_A",
  webhookUrl: "https://acme.com/webhooks/multisubs",
});
console.log(`API Key: ${tenant.apiKey}`); // msk_...

// Rotate API key
const rotated = await client.tenants.rotateKey("tenant_id");
```

## Webhook Verification

Verify incoming webhooks from MultiSubs using HMAC-SHA256:

```typescript
import {
  verifyWebhookWithTimestamp,
  verifyAndParseWebhook,
} from "@multisubs/sdk";

// Express example
app.post("/webhooks/multisubs", (req, res) => {
  const signature = req.headers["x-webhook-signature"] as string;
  const timestamp = req.headers["x-webhook-timestamp"] as string;
  const rawBody = req.body; // must be raw string, not parsed JSON

  try {
    // Verify signature + timestamp staleness (rejects webhooks > 5 min old)
    const event = verifyAndParseWebhook(rawBody, signature, secret, timestamp);

    switch (event.type) {
      case "card.authorization.approved":
        // handle approved auth
        break;
      case "card.transaction.settled":
        // handle settlement
        break;
      case "deposit.received":
        // handle deposit
        break;
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      res.status(401).json({ error: "Invalid signature" });
    }
  }
});
```

### Webhook Event Types

| Event                         | Description                       |
| ----------------------------- | --------------------------------- |
| `card.authorization.approved` | Card authorization approved       |
| `card.authorization.declined` | Card authorization declined       |
| `card.transaction.settled`    | Card transaction settled on-chain |
| `card.transaction.reversed`   | Card transaction reversed         |
| `deposit.received`            | USDC deposit received             |
| `withdrawal.initiated`        | Withdrawal initiated              |
| `withdrawal.completed`        | Withdrawal completed              |
| `yield.distributed`           | Yield distributed to tenant       |

## Error Handling

```typescript
import { ApiError, WebhookVerificationError } from "@multisubs/sdk";

try {
  await client.users.get("nonexistent");
} catch (err) {
  if (err instanceof ApiError) {
    console.log(err.status); // 404
    console.log(err.message); // "Not found"
    console.log(err.code); // optional error code
    console.log(err.isClientError); // true (4xx)
    console.log(err.isServerError); // false (5xx)
    console.log(err.isRateLimited); // false (429)
  }
}
```

## Configuration

```typescript
const client = new MultiSubsClient({
  apiKey: "msk_...", // required
  baseUrl: "https://api.multisubs.io", // optional
  timeout: 30000, // optional, ms (default 30s)
});
```

## TypeScript

Full TypeScript support with exported types:

```typescript
import type {
  User,
  Card,
  Transaction,
  YieldSummary,
  YieldSnapshot,
  Tenant,
  Balance,
  WebhookPayload,
  WebhookEventType,
  PaginatedResult,
} from "@multisubs/sdk";
```

## Development

```bash
# Type check
npx tsc --noEmit

# Build
npm run build

# Watch mode
npm run dev
```

## License

MIT
