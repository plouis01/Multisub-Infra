/**
 * Shared test mocks and helpers for the MultiSubs backend test suites.
 *
 * Provides mock implementations of PrismaClient, Redis, Viem clients,
 * and factory functions for generating test data.
 */

import { vi } from "vitest";
import type {
  AuthorizationCache,
  CardMapping,
  LithicASAEvent,
  WebhookPayload,
} from "../src/types/index.js";

// ============ Mock PrismaClient ============

export interface MockPrismaClient {
  user: {
    findUnique: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  tenant: {
    findUnique: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  subAccount: {
    findUnique: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  transaction: {
    aggregate: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
  };
  balanceLedger: {
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  auditLog: {
    create: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
  };
}

export function createMockPrisma(): MockPrismaClient {
  return {
    user: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue(null),
    },
    tenant: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue(null),
    },
    subAccount: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue(null),
    },
    transaction: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { amount: null } }),
      create: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    balanceLedger: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue(null),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
}

// ============ Mock Redis Client ============

export interface MockRedisClient {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  incr: ReturnType<typeof vi.fn>;
  expire: ReturnType<typeof vi.fn>;
  watch: ReturnType<typeof vi.fn>;
  unwatch: ReturnType<typeof vi.fn>;
  multi: ReturnType<typeof vi.fn>;
  // Internal storage for simulating state
  _store: Map<string, string>;
}

/**
 * Creates a mock Redis client that simulates basic Redis operations
 * using an in-memory Map. Supports get, set, del, incr, expire,
 * watch, unwatch, and multi/exec.
 */
export function createMockRedis(): MockRedisClient {
  const store = new Map<string, string>();

  const mockMulti = {
    set: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([["OK", "OK"]]),
  };

  const redis: MockRedisClient = {
    _store: store,

    get: vi.fn(async (key: string) => {
      return store.get(key) ?? null;
    }),

    set: vi.fn(async (key: string, value: string, ..._args: unknown[]) => {
      store.set(key, value);
      return "OK";
    }),

    del: vi.fn(async (key: string) => {
      const existed = store.has(key);
      store.delete(key);
      return existed ? 1 : 0;
    }),

    incr: vi.fn(async (key: string) => {
      const current = parseInt(store.get(key) ?? "0", 10);
      const next = current + 1;
      store.set(key, String(next));
      return next;
    }),

    expire: vi.fn(async (_key: string, _seconds: number) => {
      return 1;
    }),

    watch: vi.fn(async (_key: string) => {
      return "OK";
    }),

    unwatch: vi.fn(async () => {
      return "OK";
    }),

    multi: vi.fn(() => mockMulti),
  };

  return redis;
}

/**
 * Creates a mock Redis client where watch/multi/exec will simulate
 * a successful atomic transaction using the actual store data.
 * This is useful for testing updateAuthCacheSpend and similar functions.
 */
export function createMockRedisWithAtomicSupport(): MockRedisClient {
  const store = new Map<string, string>();

  let multiCommands: Array<{ method: string; args: unknown[] }> = [];

  const redis: MockRedisClient = {
    _store: store,

    get: vi.fn(async (key: string) => {
      return store.get(key) ?? null;
    }),

    set: vi.fn(async (key: string, value: string, ..._args: unknown[]) => {
      store.set(key, value);
      return "OK";
    }),

    del: vi.fn(async (key: string) => {
      const existed = store.has(key);
      store.delete(key);
      return existed ? 1 : 0;
    }),

    incr: vi.fn(async (key: string) => {
      const current = parseInt(store.get(key) ?? "0", 10);
      const next = current + 1;
      store.set(key, String(next));
      return next;
    }),

    expire: vi.fn(async () => 1),

    watch: vi.fn(async () => "OK"),

    unwatch: vi.fn(async () => "OK"),

    multi: vi.fn(() => {
      multiCommands = [];
      return {
        set: vi.fn((...args: unknown[]) => {
          multiCommands.push({ method: "set", args });
          return { exec: vi.fn() }; // chainable
        }),
        exec: vi.fn(async () => {
          // Execute the buffered commands
          for (const cmd of multiCommands) {
            if (cmd.method === "set") {
              const [key, value] = cmd.args as [string, string];
              store.set(key, value);
            }
          }
          return [["OK", "OK"]];
        }),
      };
    }),
  };

  return redis;
}

// ============ Mock Viem Clients ============

export function createMockPublicClient() {
  return {
    readContract: vi.fn().mockResolvedValue(0n),
    getBalance: vi.fn().mockResolvedValue(0n),
    getBlockNumber: vi.fn().mockResolvedValue(1000n),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({
      status: "success",
      transactionHash: "0x" + "a".repeat(64),
      blockNumber: 1000n,
    }),
    getTransaction: vi.fn().mockResolvedValue(null),
    getLogs: vi.fn().mockResolvedValue([]),
  };
}

export function createMockWalletClient() {
  return {
    writeContract: vi.fn().mockResolvedValue("0x" + "b".repeat(64)),
    sendTransaction: vi.fn().mockResolvedValue("0x" + "c".repeat(64)),
    account: {
      address: "0x" + "1".repeat(40),
    },
  };
}

// ============ Test Data Factories ============

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `test-id-${String(idCounter).padStart(6, "0")}`;
}

/** Reset the ID counter between test runs. */
export function resetIdCounter(): void {
  idCounter = 0;
}

export function createTestTenant(overrides: Record<string, unknown> = {}) {
  return {
    id: nextId(),
    name: "Acme Fintech",
    slug: "acme-fintech",
    custodyModel: "MODEL_A",
    webhookUrl: "https://acme.example.com/webhooks",
    webhookSecret: "whsec_test_secret_1234567890",
    apiKey: "sk_test_acme_1234567890",
    status: "active",
    createdAt: new Date("2025-01-01T00:00:00Z"),
    updatedAt: new Date("2025-01-01T00:00:00Z"),
    ...overrides,
  };
}

export function createTestUser(overrides: Record<string, unknown> = {}) {
  return {
    id: nextId(),
    tenantId: "tenant-001",
    externalId: "ext-user-001",
    eoaAddress: "0x" + "a".repeat(40),
    m2SafeAddress: "0x" + "b".repeat(40),
    kycStatus: "approved",
    email: "user@example.com",
    createdAt: new Date("2025-01-01T00:00:00Z"),
    updatedAt: new Date("2025-01-01T00:00:00Z"),
    ...overrides,
  };
}

export function createTestSubAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: nextId(),
    userId: "user-001",
    tenantId: "tenant-001",
    lithicCardToken: "card-token-001",
    status: "active",
    dailyLimit: "500000", // $5,000 in cents
    monthlyLimit: "5000000", // $50,000 in cents
    mccBlacklist: [] as string[],
    createdAt: new Date("2025-01-01T00:00:00Z"),
    updatedAt: new Date("2025-01-01T00:00:00Z"),
    ...overrides,
  };
}

export function createTestCardMapping(
  overrides: Partial<CardMapping> = {},
): CardMapping {
  return {
    subAccountId: "sub-account-001",
    tenantId: "tenant-001",
    eoaAddress: "0x" + "a".repeat(40),
    m2SafeAddress: "0x" + "b".repeat(40),
    status: "active",
    ...overrides,
  };
}

export function createTestAuthCache(
  overrides: Partial<AuthorizationCache> = {},
): AuthorizationCache {
  return {
    eoaAddress: "0x" + "a".repeat(40),
    m2SafeAddress: "0x" + "b".repeat(40),
    tenantId: "tenant-001",
    usdcBalance: "1000000", // $10,000 in cents
    dailySpent: "0",
    dailyLimit: "500000", // $5,000
    monthlySpent: "0",
    monthlyLimit: "5000000", // $50,000
    lastUpdated: Date.now(),
    ...overrides,
  };
}

export function createTestASAEvent(
  overrides: Partial<LithicASAEvent> = {},
): LithicASAEvent {
  return {
    token: "tx-token-001",
    card_token: "card-token-001",
    status: "AUTHORIZATION",
    amount: 1500, // $15.00
    merchant: {
      descriptor: "ACME WIDGETS",
      mcc: "5411", // Grocery stores
      city: "SAN FRANCISCO",
      country: "US",
    },
    created: new Date().toISOString(),
    ...overrides,
  };
}

export function createTestWebhookPayload(
  overrides: Partial<WebhookPayload> = {},
): WebhookPayload {
  return {
    id: nextId(),
    type: "card.authorization.approved",
    tenantId: "tenant-001",
    timestamp: Date.now(),
    data: {
      cardToken: "card-token-001",
      amount: 1500,
      merchant: "ACME WIDGETS",
    },
    ...overrides,
  };
}
