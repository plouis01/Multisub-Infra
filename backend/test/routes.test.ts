/**
 * Test suite for route handlers: health, users, transactions, yield.
 *
 * Tests each handler by calling it directly with mocked req/res objects
 * and mocked dependencies (Prisma, Redis). Covers happy-path and
 * error-path scenarios for all untested route handlers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createMockPrisma,
  createMockRedis,
  createTestUser,
  resetIdCounter,
  type MockPrismaClient,
  type MockRedisClient,
} from "./mocks.js";
import { createHealthRouter } from "../src/routes/health.js";
import { createUsersRouter } from "../src/routes/users.js";
import { createTransactionsRouter } from "../src/routes/transactions.js";
import { createYieldRouter } from "../src/routes/yield.js";
import type { Router } from "express";

// ============ Helpers ============

/**
 * Extract the handler function registered on an Express Router for
 * the given method and path. Walks the router's internal `stack` array
 * to find the matching Layer.
 */
function getHandler(
  router: Router,
  method: string,
  path: string,
): (req: unknown, res: unknown, next?: unknown) => Promise<void> {
  const stack = (
    router as unknown as {
      stack: Array<{
        route?: {
          path: string;
          methods: Record<string, boolean>;
          stack: Array<{ handle: (...args: unknown[]) => Promise<void> }>;
        };
      }>;
    }
  ).stack;

  for (const layer of stack) {
    if (
      layer.route &&
      layer.route.path === path &&
      layer.route.methods[method.toLowerCase()]
    ) {
      // Return the last handler in the route's stack (the actual handler,
      // not any middleware)
      return layer.route.stack[layer.route.stack.length - 1].handle as (
        req: unknown,
        res: unknown,
        next?: unknown,
      ) => Promise<void>;
    }
  }

  throw new Error(`No handler found for ${method.toUpperCase()} ${path}`);
}

/** Build a minimal mock request object. */
function mockReq(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    params: {},
    query: {},
    body: {},
    headers: {},
    tenantId: "test-tenant",
    ...overrides,
  };
}

/** Build a mock response object with spy methods. */
function mockRes() {
  const res: Record<string, unknown> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.setHeader = vi.fn().mockReturnValue(res);
  return res as {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
    setHeader: ReturnType<typeof vi.fn>;
  };
}

// ============ Health Route Tests ============

describe("Health Route", () => {
  let prisma: MockPrismaClient & { $queryRaw: ReturnType<typeof vi.fn> };
  let redis: MockRedisClient & { ping: ReturnType<typeof vi.fn> };
  let router: Router;

  beforeEach(() => {
    resetIdCounter();
    prisma = {
      ...createMockPrisma(),
      $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    };
    redis = {
      ...createMockRedis(),
      ping: vi.fn().mockResolvedValue("PONG"),
    };
    router = createHealthRouter({
      prisma: prisma as unknown as import("@prisma/client").PrismaClient,
      redis: redis as unknown as import("ioredis").Redis,
      watcher: null,
    });
  });

  it("returns 200 with ok status when DB and Redis are healthy", async () => {
    const req = mockReq();
    const res = mockRes();

    const handler = getHandler(router, "get", "/health");
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "ok",
        components: expect.objectContaining({
          database: expect.objectContaining({ status: "ok" }),
          redis: expect.objectContaining({ status: "ok" }),
        }),
      }),
    );
  });

  it("returns 503 when the database is down", async () => {
    prisma.$queryRaw.mockRejectedValueOnce(new Error("Connection refused"));

    const req = mockReq();
    const res = mockRes();

    const handler = getHandler(router, "get", "/health");
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "down",
        components: expect.objectContaining({
          database: expect.objectContaining({
            status: "down",
            detail: "Connection failed",
          }),
        }),
      }),
    );
  });

  it("returns degraded when Redis is down but DB is healthy", async () => {
    redis.ping.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const req = mockReq();
    const res = mockRes();

    const handler = getHandler(router, "get", "/health");
    await handler(req, res);

    // DB ok + Redis down => overall degraded, still 200
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "degraded",
        components: expect.objectContaining({
          database: expect.objectContaining({ status: "ok" }),
          redis: expect.objectContaining({
            status: "down",
            detail: "Connection failed",
          }),
        }),
      }),
    );
  });
});

// ============ Users Route Tests ============

describe("Users Route", () => {
  let prisma: MockPrismaClient & {
    user: MockPrismaClient["user"] & { findFirst: ReturnType<typeof vi.fn> };
  };
  let router: Router;

  beforeEach(() => {
    resetIdCounter();
    const basePrisma = createMockPrisma();
    prisma = {
      ...basePrisma,
      user: {
        ...basePrisma.user,
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };
    router = createUsersRouter({
      prisma: prisma as unknown as import("@prisma/client").PrismaClient,
    });
  });

  // ---------- POST /v1/users ----------

  describe("POST /v1/users", () => {
    it("creates a user successfully and returns 201", async () => {
      const createdUser = createTestUser({
        id: "new-user-1",
        externalId: "ext-123",
        email: "test@example.com",
        kycStatus: "pending",
      });

      // findUnique returns null => no duplicate
      prisma.user.findUnique.mockResolvedValueOnce(null);
      prisma.user.create.mockResolvedValueOnce(createdUser);

      const req = mockReq({
        body: {
          externalId: "ext-123",
          email: "test@example.com",
          kycStatus: "pending",
        },
      });
      const res = mockRes();

      const handler = getHandler(router, "post", "/v1/users");
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(createdUser);
      expect(prisma.user.create).toHaveBeenCalledOnce();
    });

    it("returns 400 on invalid body (missing externalId)", async () => {
      const req = mockReq({ body: {} });
      const res = mockRes();

      const handler = getHandler(router, "post", "/v1/users");
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: "Validation failed" }),
      );
    });

    it("returns 409 when user with same externalId already exists", async () => {
      const existingUser = createTestUser({
        id: "existing-user",
        externalId: "ext-123",
      });
      prisma.user.findUnique.mockResolvedValueOnce(existingUser);

      const req = mockReq({
        body: { externalId: "ext-123", kycStatus: "pending" },
      });
      const res = mockRes();

      const handler = getHandler(router, "post", "/v1/users");
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: "User already exists" }),
      );
    });

    it("returns 500 when prisma.user.create throws", async () => {
      prisma.user.findUnique.mockResolvedValueOnce(null);
      prisma.user.create.mockRejectedValueOnce(new Error("DB error"));

      const req = mockReq({
        body: { externalId: "ext-123", kycStatus: "pending" },
      });
      const res = mockRes();

      const handler = getHandler(router, "post", "/v1/users");
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: "Internal server error" });
    });
  });

  // ---------- GET /v1/users/:id ----------

  describe("GET /v1/users/:id", () => {
    it("returns user when found", async () => {
      const user = {
        ...createTestUser({ id: "user-1" }),
        subAccounts: [
          {
            id: "sa-1",
            type: "virtual",
            lithicCardToken: "tok-1",
            dailyLimit: 500000n,
            monthlyLimit: 5000000n,
            status: "active",
            createdAt: new Date(),
          },
        ],
      };
      prisma.user.findFirst.mockResolvedValueOnce(user);

      const req = mockReq({ params: { id: "user-1" } });
      const res = mockRes();

      const handler = getHandler(router, "get", "/v1/users/:id");
      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "user-1",
          subAccounts: [
            expect.objectContaining({
              id: "sa-1",
              dailyLimit: "500000",
              monthlyLimit: "5000000",
            }),
          ],
        }),
      );
      // Should not have called status (defaults to 200)
      expect(res.status).not.toHaveBeenCalled();
    });

    it("returns 404 when user is not found", async () => {
      prisma.user.findFirst.mockResolvedValueOnce(null);

      const req = mockReq({ params: { id: "nonexistent" } });
      const res = mockRes();

      const handler = getHandler(router, "get", "/v1/users/:id");
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: "User not found" });
    });

    it("returns 400 for empty id parameter", async () => {
      const req = mockReq({ params: { id: "" } });
      const res = mockRes();

      const handler = getHandler(router, "get", "/v1/users/:id");
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: "Invalid ID format" });
    });
  });

  // ---------- GET /v1/users/:id/balance ----------

  describe("GET /v1/users/:id/balance", () => {
    it("returns balance with daily and monthly spend", async () => {
      prisma.user.findFirst.mockResolvedValueOnce({ id: "user-1" });

      // Ledger entries: one deposit of 100_000, one spend of 15_00
      (
        prisma as unknown as {
          balanceLedger: { findMany: ReturnType<typeof vi.fn> };
        }
      ).balanceLedger.findMany.mockResolvedValueOnce([
        { type: "deposit", amount: "100000" },
        { type: "authorization", amount: "1500" },
      ]);

      // Daily and monthly aggregates
      (
        prisma as unknown as {
          transaction: { aggregate: ReturnType<typeof vi.fn> };
        }
      ).transaction.aggregate
        .mockResolvedValueOnce({ _sum: { amount: 1500n } }) // daily
        .mockResolvedValueOnce({ _sum: { amount: 5000n } }); // monthly

      const req = mockReq({ params: { id: "user-1" } });
      const res = mockRes();

      const handler = getHandler(router, "get", "/v1/users/:id/balance");
      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({
        userId: "user-1",
        token: "USDC",
        balance: "98500", // 100000 - 1500
        dailySpent: "1500",
        monthlySpent: "5000",
      });
    });

    it("returns 404 when user is not found", async () => {
      prisma.user.findFirst.mockResolvedValueOnce(null);

      const req = mockReq({ params: { id: "nonexistent" } });
      const res = mockRes();

      const handler = getHandler(router, "get", "/v1/users/:id/balance");
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: "User not found" });
    });

    it("returns zero balance when no ledger entries exist", async () => {
      prisma.user.findFirst.mockResolvedValueOnce({ id: "user-1" });

      (
        prisma as unknown as {
          balanceLedger: { findMany: ReturnType<typeof vi.fn> };
        }
      ).balanceLedger.findMany.mockResolvedValueOnce([]);

      (
        prisma as unknown as {
          transaction: { aggregate: ReturnType<typeof vi.fn> };
        }
      ).transaction.aggregate
        .mockResolvedValueOnce({ _sum: { amount: null } })
        .mockResolvedValueOnce({ _sum: { amount: null } });

      const req = mockReq({ params: { id: "user-1" } });
      const res = mockRes();

      const handler = getHandler(router, "get", "/v1/users/:id/balance");
      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({
        userId: "user-1",
        token: "USDC",
        balance: "0",
        dailySpent: "0",
        monthlySpent: "0",
      });
    });
  });
});

// ============ Transactions Route Tests ============

describe("Transactions Route", () => {
  let prisma: MockPrismaClient & {
    transaction: MockPrismaClient["transaction"] & {
      findFirst: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
    };
  };
  let router: Router;

  beforeEach(() => {
    resetIdCounter();
    const basePrisma = createMockPrisma();
    prisma = {
      ...basePrisma,
      transaction: {
        ...basePrisma.transaction,
        findFirst: vi.fn().mockResolvedValue(null),
        count: vi.fn().mockResolvedValue(0),
      },
    };
    router = createTransactionsRouter({
      prisma: prisma as unknown as import("@prisma/client").PrismaClient,
    });
  });

  // ---------- GET /v1/transactions ----------

  describe("GET /v1/transactions", () => {
    it("returns paginated results", async () => {
      const txs = [
        {
          id: "tx-1",
          userId: "user-1",
          subAccountId: "sa-1",
          lithicTxToken: "ltx-1",
          type: "authorization",
          amount: 1500n,
          currency: "USD",
          merchantName: "ACME",
          merchantMcc: "5411",
          status: "approved",
          onChainTxHash: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];
      prisma.transaction.findMany.mockResolvedValueOnce(txs);
      prisma.transaction.count.mockResolvedValueOnce(1);

      const req = mockReq({ query: { limit: "10", offset: "0" } });
      const res = mockRes();

      const handler = getHandler(router, "get", "/v1/transactions");
      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({
        items: [
          expect.objectContaining({
            id: "tx-1",
            amount: "1500",
          }),
        ],
        total: 1,
        limit: 10,
        offset: 0,
      });
    });

    it("returns empty list when no transactions match", async () => {
      prisma.transaction.findMany.mockResolvedValueOnce([]);
      prisma.transaction.count.mockResolvedValueOnce(0);

      const req = mockReq({ query: {} });
      const res = mockRes();

      const handler = getHandler(router, "get", "/v1/transactions");
      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          items: [],
          total: 0,
        }),
      );
    });

    it("returns 500 when database throws", async () => {
      prisma.transaction.findMany.mockRejectedValueOnce(new Error("DB error"));

      const req = mockReq({ query: {} });
      const res = mockRes();

      const handler = getHandler(router, "get", "/v1/transactions");
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: "Internal server error" });
    });
  });

  // ---------- GET /v1/transactions/:id ----------

  describe("GET /v1/transactions/:id", () => {
    it("returns a single transaction", async () => {
      const tx = {
        id: "tx-1",
        userId: "user-1",
        subAccountId: "sa-1",
        lithicTxToken: "ltx-1",
        type: "authorization",
        amount: 2500n,
        currency: "USD",
        merchantName: "Widget Co",
        merchantMcc: "5999",
        status: "settled",
        onChainTxHash: "0x" + "f".repeat(64),
        settlementNonce: 42n,
        errorMessage: null,
        retryCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      prisma.transaction.findFirst.mockResolvedValueOnce(tx);

      const req = mockReq({ params: { id: "tx-1" } });
      const res = mockRes();

      const handler = getHandler(router, "get", "/v1/transactions/:id");
      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "tx-1",
          amount: "2500",
          settlementNonce: "42",
        }),
      );
    });

    it("returns 404 when transaction is not found", async () => {
      prisma.transaction.findFirst.mockResolvedValueOnce(null);

      const req = mockReq({ params: { id: "nonexistent" } });
      const res = mockRes();

      const handler = getHandler(router, "get", "/v1/transactions/:id");
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        error: "Transaction not found",
      });
    });

    it("returns 400 for empty id parameter", async () => {
      const req = mockReq({ params: { id: "" } });
      const res = mockRes();

      const handler = getHandler(router, "get", "/v1/transactions/:id");
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: "Invalid ID format" });
    });
  });
});

// ============ Yield Route Tests ============

describe("Yield Route", () => {
  let prisma: MockPrismaClient & {
    yieldLedger: {
      findFirst: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
    };
  };
  let router: Router;

  beforeEach(() => {
    resetIdCounter();
    prisma = {
      ...createMockPrisma(),
      yieldLedger: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
    };
    router = createYieldRouter({
      prisma: prisma as unknown as import("@prisma/client").PrismaClient,
    });
  });

  // ---------- GET /v1/yield/summary ----------

  describe("GET /v1/yield/summary", () => {
    it("returns the latest yield snapshot", async () => {
      const snapshot = {
        totalDeposited: "1000000",
        totalShares: "500000",
        totalYield: "12500",
        apyBps: 450,
        snapshotDate: new Date("2025-06-01"),
      };
      prisma.yieldLedger.findFirst.mockResolvedValueOnce(snapshot);

      const req = mockReq();
      const res = mockRes();

      const handler = getHandler(router, "get", "/v1/yield/summary");
      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({
        totalDeposited: "1000000",
        totalShares: "500000",
        unrealizedYield: "12500",
        apyBps: 450,
        snapshotDate: new Date("2025-06-01"),
      });
    });

    it("returns zero values when no snapshot exists", async () => {
      prisma.yieldLedger.findFirst.mockResolvedValueOnce(null);

      const req = mockReq();
      const res = mockRes();

      const handler = getHandler(router, "get", "/v1/yield/summary");
      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({
        totalDeposited: "0",
        totalShares: "0",
        unrealizedYield: "0",
        apyBps: 0,
        snapshotDate: null,
      });
    });

    it("returns 500 when database throws", async () => {
      prisma.yieldLedger.findFirst.mockRejectedValueOnce(new Error("DB error"));

      const req = mockReq();
      const res = mockRes();

      const handler = getHandler(router, "get", "/v1/yield/summary");
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: "Internal server error" });
    });
  });

  // ---------- GET /v1/yield/snapshots ----------

  describe("GET /v1/yield/snapshots", () => {
    it("returns paginated snapshots", async () => {
      const snapshots = [
        {
          id: "yl-1",
          snapshotDate: new Date("2025-06-01"),
          totalDeposited: "1000000",
          totalShares: "500000",
          totalYield: "12500",
          apyBps: 450,
          createdAt: new Date(),
        },
      ];
      prisma.yieldLedger.findMany.mockResolvedValueOnce(snapshots);
      prisma.yieldLedger.count.mockResolvedValueOnce(1);

      const req = mockReq({ query: { limit: "10", offset: "0" } });
      const res = mockRes();

      const handler = getHandler(router, "get", "/v1/yield/snapshots");
      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({
        items: snapshots,
        total: 1,
        limit: 10,
        offset: 0,
      });
    });

    it("returns empty list when no snapshots exist", async () => {
      prisma.yieldLedger.findMany.mockResolvedValueOnce([]);
      prisma.yieldLedger.count.mockResolvedValueOnce(0);

      const req = mockReq({ query: {} });
      const res = mockRes();

      const handler = getHandler(router, "get", "/v1/yield/snapshots");
      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          items: [],
          total: 0,
        }),
      );
    });

    it("returns 500 when database throws", async () => {
      prisma.yieldLedger.findMany.mockRejectedValueOnce(new Error("DB error"));

      const req = mockReq({ query: {} });
      const res = mockRes();

      const handler = getHandler(router, "get", "/v1/yield/snapshots");
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: "Internal server error" });
    });
  });
});
