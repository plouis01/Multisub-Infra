/**
 * Test suite for the AuthorizationEngine.
 *
 * Covers: valid authorizations, card lookup failures, frozen cards,
 * KYC rejection, insufficient balance, daily/monthly limit enforcement,
 * MCC blacklist blocking, cache misses, and concurrent atomic updates.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createMockPrisma,
  createMockRedis,
  createTestCardMapping,
  createTestAuthCache,
  createTestASAEvent,
  resetIdCounter,
  type MockPrismaClient,
  type MockRedisClient,
} from "./mocks.js";

// Mock the redis module so that the AuthorizationEngine's internal calls
// to getAuthCache, setAuthCache, etc. use our mock implementations.
vi.mock("../src/lib/redis.js", () => ({
  getAuthCache: vi.fn(),
  setAuthCache: vi.fn(),
  getCardMapping: vi.fn(),
  setCardMapping: vi.fn(),
  updateAuthCacheSpend: vi.fn(),
}));

import { AuthorizationEngine } from "../src/services/authorization-engine.js";
import {
  getAuthCache,
  setAuthCache,
  getCardMapping,
  setCardMapping,
  updateAuthCacheSpend,
} from "../src/lib/redis.js";
import type {
  AuthorizationCache,
  CardMapping,
  LithicASAEvent,
} from "../src/types/index.js";

// Typed references to the mocked functions
const mockGetAuthCache = getAuthCache as ReturnType<typeof vi.fn>;
const mockSetAuthCache = setAuthCache as ReturnType<typeof vi.fn>;
const mockGetCardMapping = getCardMapping as ReturnType<typeof vi.fn>;
const mockSetCardMapping = setCardMapping as ReturnType<typeof vi.fn>;
const mockUpdateAuthCacheSpend = updateAuthCacheSpend as ReturnType<
  typeof vi.fn
>;

describe("AuthorizationEngine", () => {
  let prisma: MockPrismaClient;
  let redis: MockRedisClient;
  let engine: AuthorizationEngine;

  // Reusable defaults
  let defaultCardMapping: CardMapping;
  let defaultAuthCache: AuthorizationCache;
  let defaultEvent: LithicASAEvent;

  beforeEach(() => {
    resetIdCounter();
    prisma = createMockPrisma();
    redis = createMockRedis();
    engine = new AuthorizationEngine(redis as any, prisma as any);

    defaultCardMapping = createTestCardMapping();
    defaultAuthCache = createTestAuthCache();
    defaultEvent = createTestASAEvent();

    // Default happy-path mocks
    mockGetCardMapping.mockResolvedValue(defaultCardMapping);
    mockGetAuthCache.mockResolvedValue(defaultAuthCache);
    mockSetAuthCache.mockResolvedValue(undefined);
    mockSetCardMapping.mockResolvedValue(undefined);
    mockUpdateAuthCacheSpend.mockResolvedValue({
      ...defaultAuthCache,
      usdcBalance: (
        BigInt(defaultAuthCache.usdcBalance) - BigInt(defaultEvent.amount)
      ).toString(),
      dailySpent: (
        BigInt(defaultAuthCache.dailySpent) + BigInt(defaultEvent.amount)
      ).toString(),
      monthlySpent: (
        BigInt(defaultAuthCache.monthlySpent) + BigInt(defaultEvent.amount)
      ).toString(),
      lastUpdated: Date.now(),
    });

    // KYC check returns approved
    prisma.user.findUnique.mockResolvedValue({ kycStatus: "approved" });

    // MCC blacklist check: no per-card blacklist
    prisma.subAccount.findUnique.mockResolvedValue({ mccBlacklist: [] });

    // Audit log succeeds silently
    prisma.auditLog.create.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ----------------------------------------------------------------
  // Happy path
  // ----------------------------------------------------------------

  it("approves a valid authorization within limits", async () => {
    const result = await engine.authorize(defaultEvent);

    expect(result.approved).toBe(true);
    expect(result.balanceAfter).toBeDefined();
    expect(result.reason).toBeUndefined();

    // Verify the card lookup was called
    expect(mockGetCardMapping).toHaveBeenCalledWith(
      redis,
      defaultEvent.card_token,
    );

    // Verify the atomic spend update was called
    expect(mockUpdateAuthCacheSpend).toHaveBeenCalledWith(
      redis,
      defaultCardMapping.eoaAddress,
      Math.abs(defaultEvent.amount),
    );
  });

  it("returns the correct post-authorization balance", async () => {
    const initialBalance = BigInt(defaultAuthCache.usdcBalance);
    const spendAmount = BigInt(Math.abs(defaultEvent.amount));
    const expectedBalance = (initialBalance - spendAmount).toString();

    mockUpdateAuthCacheSpend.mockResolvedValue({
      ...defaultAuthCache,
      usdcBalance: expectedBalance,
      dailySpent: spendAmount.toString(),
      monthlySpent: spendAmount.toString(),
      lastUpdated: Date.now(),
    });

    const result = await engine.authorize(defaultEvent);

    expect(result.approved).toBe(true);
    expect(result.balanceAfter).toBe(expectedBalance);
  });

  // ----------------------------------------------------------------
  // Non-authorization events
  // ----------------------------------------------------------------

  it("declines non-AUTHORIZATION events", async () => {
    const clearingEvent = createTestASAEvent({ status: "CLEARING" });
    const result = await engine.authorize(clearingEvent);

    expect(result.approved).toBe(false);
    expect(result.reason).toContain("Non-authorization event");
  });

  it("declines events with zero amount", async () => {
    const zeroEvent = createTestASAEvent({ amount: 0 });
    const result = await engine.authorize(zeroEvent);

    expect(result.approved).toBe(false);
    expect(result.reason).toContain("Invalid authorization amount");
  });

  // ----------------------------------------------------------------
  // Card lookup failures
  // ----------------------------------------------------------------

  it("declines when card not found", async () => {
    mockGetCardMapping.mockResolvedValue(null);

    const result = await engine.authorize(defaultEvent);

    expect(result.approved).toBe(false);
    expect(result.reason).toBe("Card not found");
  });

  // ----------------------------------------------------------------
  // Card state checks
  // ----------------------------------------------------------------

  it("declines when card is frozen", async () => {
    mockGetCardMapping.mockResolvedValue(
      createTestCardMapping({ status: "frozen" }),
    );

    const result = await engine.authorize(defaultEvent);

    expect(result.approved).toBe(false);
    expect(result.reason).toContain("Card is frozen");
  });

  it("declines when card is cancelled", async () => {
    mockGetCardMapping.mockResolvedValue(
      createTestCardMapping({ status: "cancelled" }),
    );

    const result = await engine.authorize(defaultEvent);

    expect(result.approved).toBe(false);
    expect(result.reason).toContain("Card is cancelled");
  });

  // ----------------------------------------------------------------
  // KYC checks
  // ----------------------------------------------------------------

  it("declines when KYC is not approved", async () => {
    prisma.user.findUnique.mockResolvedValue({ kycStatus: "pending" });

    const result = await engine.authorize(defaultEvent);

    expect(result.approved).toBe(false);
    expect(result.reason).toBe("KYC not approved");
  });

  it("declines when KYC status is rejected", async () => {
    prisma.user.findUnique.mockResolvedValue({ kycStatus: "rejected" });

    const result = await engine.authorize(defaultEvent);

    expect(result.approved).toBe(false);
    expect(result.reason).toBe("KYC not approved");
  });

  it("declines when user not found for KYC check", async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    const result = await engine.authorize(defaultEvent);

    expect(result.approved).toBe(false);
    expect(result.reason).toBe("KYC not approved");
  });

  // ----------------------------------------------------------------
  // Balance checks
  // ----------------------------------------------------------------

  it("declines when insufficient balance", async () => {
    mockGetAuthCache.mockResolvedValue(
      createTestAuthCache({ usdcBalance: "100" }), // Only $1.00, need $15.00
    );

    const result = await engine.authorize(defaultEvent);

    expect(result.approved).toBe(false);
    expect(result.reason).toContain("Insufficient balance");
  });

  it("declines when balance exactly equals zero", async () => {
    mockGetAuthCache.mockResolvedValue(
      createTestAuthCache({ usdcBalance: "0" }),
    );

    const result = await engine.authorize(defaultEvent);

    expect(result.approved).toBe(false);
    expect(result.reason).toContain("Insufficient balance");
  });

  it("approves when balance exactly matches the amount", async () => {
    const amount = Math.abs(defaultEvent.amount);
    mockGetAuthCache.mockResolvedValue(
      createTestAuthCache({ usdcBalance: String(amount) }),
    );

    const result = await engine.authorize(defaultEvent);

    expect(result.approved).toBe(true);
  });

  // ----------------------------------------------------------------
  // Daily limit checks
  // ----------------------------------------------------------------

  it("declines when daily limit would be exceeded", async () => {
    // Daily limit is 500000 ($5,000), already spent 499900
    mockGetAuthCache.mockResolvedValue(
      createTestAuthCache({
        dailySpent: "499900",
        dailyLimit: "500000",
      }),
    );
    // Event amount is 1500 ($15.00), 499900 + 1500 = 501400 > 500000

    const result = await engine.authorize(defaultEvent);

    expect(result.approved).toBe(false);
    expect(result.reason).toContain("Daily limit exceeded");
  });

  it("approves when daily spend exactly reaches the limit", async () => {
    const amount = Math.abs(defaultEvent.amount);
    // If spent + amount == limit, it's still allowed (not exceeded)
    mockGetAuthCache.mockResolvedValue(
      createTestAuthCache({
        dailySpent: String(500000 - amount),
        dailyLimit: "500000",
      }),
    );

    const result = await engine.authorize(defaultEvent);

    expect(result.approved).toBe(true);
  });

  // ----------------------------------------------------------------
  // Monthly limit checks
  // ----------------------------------------------------------------

  it("declines when monthly limit would be exceeded", async () => {
    // Monthly limit is 5000000 ($50,000), already spent 4999900
    mockGetAuthCache.mockResolvedValue(
      createTestAuthCache({
        monthlySpent: "4999900",
        monthlyLimit: "5000000",
      }),
    );
    // 4999900 + 1500 = 5001400 > 5000000

    const result = await engine.authorize(defaultEvent);

    expect(result.approved).toBe(false);
    expect(result.reason).toContain("Monthly limit exceeded");
  });

  it("approves when monthly spend exactly reaches the limit", async () => {
    const amount = Math.abs(defaultEvent.amount);
    mockGetAuthCache.mockResolvedValue(
      createTestAuthCache({
        monthlySpent: String(5000000 - amount),
        monthlyLimit: "5000000",
      }),
    );

    const result = await engine.authorize(defaultEvent);

    expect(result.approved).toBe(true);
  });

  // ----------------------------------------------------------------
  // MCC blacklist checks
  // ----------------------------------------------------------------

  it("declines when MCC is in the global blacklist (gambling)", async () => {
    const gamblingEvent = createTestASAEvent({
      merchant: {
        descriptor: "CASINO ROYALE",
        mcc: "7995", // Gambling
        city: "LAS VEGAS",
        country: "US",
      },
    });

    const result = await engine.authorize(gamblingEvent);

    expect(result.approved).toBe(false);
    expect(result.reason).toContain("Blocked MCC: 7995");
  });

  it("declines when MCC is in the global blacklist (crypto)", async () => {
    const cryptoEvent = createTestASAEvent({
      merchant: {
        descriptor: "CRYPTO EXCHANGE",
        mcc: "6051", // Crypto / quasi-cash
      },
    });

    const result = await engine.authorize(cryptoEvent);

    expect(result.approved).toBe(false);
    expect(result.reason).toContain("Blocked MCC: 6051");
  });

  it("declines when MCC is in the per-card blacklist", async () => {
    // MCC 5812 = Eating places/restaurants (not on global blacklist)
    prisma.subAccount.findUnique.mockResolvedValue({
      mccBlacklist: ["5812"],
    });

    const restaurantEvent = createTestASAEvent({
      merchant: {
        descriptor: "FANCY RESTAURANT",
        mcc: "5812",
        city: "NYC",
        country: "US",
      },
    });

    const result = await engine.authorize(restaurantEvent);

    expect(result.approved).toBe(false);
    expect(result.reason).toContain("Blocked MCC: 5812");
  });

  it("approves when MCC is not blacklisted", async () => {
    // MCC 5411 = Grocery stores (default in test event, not blacklisted)
    const result = await engine.authorize(defaultEvent);

    expect(result.approved).toBe(true);
  });

  // ----------------------------------------------------------------
  // Cache miss: rebuilds from DB
  // ----------------------------------------------------------------

  it("rebuilds auth cache from DB on cache miss", async () => {
    // First call returns null (cache miss), second returns the rebuilt cache
    mockGetAuthCache
      .mockResolvedValueOnce(null) // Initial miss
      .mockResolvedValueOnce(defaultAuthCache); // After rebuild

    // Mock the DB lookups for refreshCache
    prisma.user.findUnique
      // First call is for KYC (used by checkKycStatus) — there is no separate
      // first call in the engine flow for this case since getOrBuildAuthCache
      // triggers after KYC; the KYC call uses a separate findUnique.
      // But we need to set up multiple return values:
      // 1st call: KYC check (returns approved)
      // 2nd call: refreshCache user lookup
      .mockResolvedValueOnce({ kycStatus: "approved" })
      .mockResolvedValueOnce({
        id: "user-001",
        tenantId: "tenant-001",
        eoaAddress: "0x" + "a".repeat(40),
        m2SafeAddress: "0x" + "b".repeat(40),
        subAccounts: [
          {
            id: "sub-001",
            status: "active",
            dailyLimit: BigInt(500000),
            monthlyLimit: BigInt(5000000),
            lithicCardToken: "card-token-001",
            createdAt: new Date(),
          },
        ],
      });

    prisma.transaction.aggregate
      .mockResolvedValueOnce({ _sum: { amount: 0n } }) // daily
      .mockResolvedValueOnce({ _sum: { amount: 0n } }); // monthly

    prisma.balanceLedger.findMany.mockResolvedValue([
      { type: "deposit", amount: BigInt(1000000) },
    ]);

    const result = await engine.authorize(defaultEvent);

    expect(result.approved).toBe(true);
    // Verify setAuthCache was called during rebuild
    expect(mockSetAuthCache).toHaveBeenCalled();
  });

  it("declines when cache rebuild fails", async () => {
    // Cache miss and rebuild also fails
    mockGetAuthCache.mockResolvedValue(null);

    // KYC check still passes
    prisma.user.findUnique
      .mockResolvedValueOnce({ kycStatus: "approved" }) // KYC check
      .mockResolvedValueOnce(null); // refreshCache: user not found

    const result = await engine.authorize(defaultEvent);

    expect(result.approved).toBe(false);
    expect(result.reason).toBe("Unable to load authorization cache");
  });

  // ----------------------------------------------------------------
  // Concurrent authorizations (atomic update failures)
  // ----------------------------------------------------------------

  it("declines when all atomic update retries are exhausted", async () => {
    // Simulate WATCH contention: updateAuthCacheSpend returns null every time
    mockUpdateAuthCacheSpend.mockResolvedValue(null);

    const result = await engine.authorize(defaultEvent);

    expect(result.approved).toBe(false);
    expect(result.reason).toContain("Concurrent modification");
  });

  it("succeeds when atomic update works on retry", async () => {
    const updatedCache = {
      ...defaultAuthCache,
      usdcBalance: (
        BigInt(defaultAuthCache.usdcBalance) - BigInt(defaultEvent.amount)
      ).toString(),
      dailySpent: BigInt(defaultEvent.amount).toString(),
      monthlySpent: BigInt(defaultEvent.amount).toString(),
      lastUpdated: Date.now(),
    };

    // First two attempts fail, third succeeds
    mockUpdateAuthCacheSpend
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(updatedCache);

    const result = await engine.authorize(defaultEvent);

    expect(result.approved).toBe(true);
    expect(result.balanceAfter).toBe(updatedCache.usdcBalance);
    // Verify it was called 3 times (initial + 2 retries)
    expect(mockUpdateAuthCacheSpend).toHaveBeenCalledTimes(3);
  });

  // ----------------------------------------------------------------
  // Audit logging
  // ----------------------------------------------------------------

  it("records audit log on successful authorization", async () => {
    await engine.authorize(defaultEvent);

    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "auth_approved",
        }),
      }),
    );
  });

  it("records audit log on declined authorization", async () => {
    mockGetCardMapping.mockResolvedValue(null);

    await engine.authorize(defaultEvent);

    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "auth_declined",
        }),
      }),
    );
  });

  it("does not fail authorization if audit log write fails", async () => {
    prisma.auditLog.create.mockRejectedValue(new Error("DB write failed"));

    const result = await engine.authorize(defaultEvent);

    // Should still approve because audit logging is best-effort
    expect(result.approved).toBe(true);
  });

  // ----------------------------------------------------------------
  // Negative amount handling
  // ----------------------------------------------------------------

  it("uses absolute value for negative amounts", async () => {
    const negativeEvent = createTestASAEvent({ amount: -2500 });

    const updatedCache = {
      ...defaultAuthCache,
      usdcBalance: (
        BigInt(defaultAuthCache.usdcBalance) - BigInt(2500)
      ).toString(),
      dailySpent: "2500",
      monthlySpent: "2500",
      lastUpdated: Date.now(),
    };
    mockUpdateAuthCacheSpend.mockResolvedValue(updatedCache);

    const result = await engine.authorize(negativeEvent);

    expect(result.approved).toBe(true);
    // The engine should use Math.abs, so the spend amount passed should be 2500
    expect(mockUpdateAuthCacheSpend).toHaveBeenCalledWith(
      redis,
      defaultCardMapping.eoaAddress,
      2500,
    );
  });

  // ----------------------------------------------------------------
  // Internal error handling
  // ----------------------------------------------------------------

  it("declines on unexpected internal errors", async () => {
    mockGetCardMapping.mockRejectedValue(new Error("Redis connection lost"));

    const result = await engine.authorize(defaultEvent);

    expect(result.approved).toBe(false);
    expect(result.reason).toBe("Internal authorization error");
  });
});
