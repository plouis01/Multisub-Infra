/**
 * Test suite for Redis helper functions.
 *
 * Covers: auth cache get/set, atomic spend updates, card mapping
 * get/set round-trips, and rate limiting behavior.
 *
 * Uses a mock Redis client backed by an in-memory Map so no real
 * Redis connection is required.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createMockRedisWithAtomicSupport,
  createTestAuthCache,
  createTestCardMapping,
  type MockRedisClient,
} from "./mocks.js";

// We test the actual functions, not mocked ones, but they receive a mock Redis
import {
  getAuthCache,
  setAuthCache,
  updateAuthCacheSpend,
  getCardMapping,
  setCardMapping,
  checkRateLimit,
} from "../src/lib/redis.js";
import type { AuthorizationCache, CardMapping } from "../src/types/index.js";

describe("Redis helper functions", () => {
  let redis: MockRedisClient;

  beforeEach(() => {
    redis = createMockRedisWithAtomicSupport();
  });

  // ================================================================
  // getAuthCache
  // ================================================================

  describe("getAuthCache", () => {
    it("returns null for a missing key", async () => {
      const result = await getAuthCache(redis as any, "0xnonexistent");

      expect(result).toBeNull();
    });

    it("returns parsed AuthorizationCache for an existing key", async () => {
      const cache = createTestAuthCache({
        eoaAddress: "0xabc123",
        usdcBalance: "500000",
      });

      // Pre-populate the store
      redis._store.set("auth:0xabc123", JSON.stringify(cache));

      const result = await getAuthCache(redis as any, "0xABC123"); // uppercase to test normalization

      expect(result).not.toBeNull();
      expect(result!.eoaAddress).toBe("0xabc123");
      expect(result!.usdcBalance).toBe("500000");
    });

    it("normalizes the EOA address to lowercase", async () => {
      const cache = createTestAuthCache({ eoaAddress: "0xdeadbeef" });
      redis._store.set("auth:0xdeadbeef", JSON.stringify(cache));

      const result = await getAuthCache(redis as any, "0xDEADBEEF");

      expect(result).not.toBeNull();
      expect(result!.eoaAddress).toBe("0xdeadbeef");
      expect(redis.get).toHaveBeenCalledWith("auth:0xdeadbeef");
    });
  });

  // ================================================================
  // setAuthCache
  // ================================================================

  describe("setAuthCache", () => {
    it("stores AuthorizationCache and retrieves it correctly", async () => {
      const cache = createTestAuthCache({
        eoaAddress: "0xuser001",
        usdcBalance: "750000",
        dailySpent: "25000",
        monthlySpent: "100000",
      });

      await setAuthCache(redis as any, "0xUSER001", cache, 300);

      // Verify it was stored via set
      expect(redis.set).toHaveBeenCalledWith(
        "auth:0xuser001",
        JSON.stringify(cache),
        "EX",
        300,
      );

      // Verify round-trip via the store
      const stored = redis._store.get("auth:0xuser001");
      expect(stored).toBeDefined();

      const parsed = JSON.parse(stored!) as AuthorizationCache;
      expect(parsed.usdcBalance).toBe("750000");
      expect(parsed.dailySpent).toBe("25000");
      expect(parsed.monthlySpent).toBe("100000");
    });

    it("uses default TTL of 300 seconds when not specified", async () => {
      const cache = createTestAuthCache();

      await setAuthCache(redis as any, "0xtest", cache);

      expect(redis.set).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        "EX",
        300,
      );
    });

    it("accepts a custom TTL", async () => {
      const cache = createTestAuthCache();

      await setAuthCache(redis as any, "0xtest", cache, 600);

      expect(redis.set).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        "EX",
        600,
      );
    });

    it("overwrites existing cache for the same address", async () => {
      const cache1 = createTestAuthCache({ usdcBalance: "100000" });
      const cache2 = createTestAuthCache({ usdcBalance: "200000" });

      await setAuthCache(redis as any, "0xuser", cache1);
      await setAuthCache(redis as any, "0xuser", cache2);

      const stored = redis._store.get("auth:0xuser");
      const parsed = JSON.parse(stored!) as AuthorizationCache;
      expect(parsed.usdcBalance).toBe("200000");
    });
  });

  // ================================================================
  // updateAuthCacheSpend
  // ================================================================

  describe("updateAuthCacheSpend", () => {
    it("atomically updates balances after a spend", async () => {
      const cache = createTestAuthCache({
        eoaAddress: "0xspender",
        usdcBalance: "100000",
        dailySpent: "5000",
        dailyLimit: "500000",
        monthlySpent: "20000",
        monthlyLimit: "5000000",
      });

      // Pre-populate
      redis._store.set("auth:0xspender", JSON.stringify(cache));

      const { cache: result } = await updateAuthCacheSpend(
        redis as any,
        "0xSPENDER",
        1500,
      );

      expect(result).not.toBeNull();
      expect(result!.usdcBalance).toBe("98500"); // 100000 - 1500
      expect(result!.dailySpent).toBe("6500"); // 5000 + 1500
      expect(result!.monthlySpent).toBe("21500"); // 20000 + 1500
      expect(result!.lastUpdated).toBeGreaterThan(0);
    });

    it("returns null cache when key does not exist", async () => {
      const { cache, error } = await updateAuthCacheSpend(
        redis as any,
        "0xnonexistent",
        1000,
      );

      expect(cache).toBeNull();
      expect(error).toBeUndefined();
      expect(redis.unwatch).toHaveBeenCalled();
    });

    it("returns error when insufficient balance", async () => {
      const cache = createTestAuthCache({
        eoaAddress: "0xpoor",
        usdcBalance: "500",
        dailyLimit: "0",
        monthlyLimit: "0",
      });
      redis._store.set("auth:0xpoor", JSON.stringify(cache));

      const { cache: result, error } = await updateAuthCacheSpend(
        redis as any,
        "0xPOOR",
        1000,
      );

      expect(result).toBeNull();
      expect(error).toBe("insufficient_balance");
    });

    it("returns error when daily limit exceeded", async () => {
      const cache = createTestAuthCache({
        eoaAddress: "0xlimited",
        usdcBalance: "100000",
        dailySpent: "9000",
        dailyLimit: "10000",
        monthlyLimit: "0",
      });
      redis._store.set("auth:0xlimited", JSON.stringify(cache));

      const { cache: result, error } = await updateAuthCacheSpend(
        redis as any,
        "0xLIMITED",
        2000,
      );

      expect(result).toBeNull();
      expect(error).toBe("daily_limit");
    });

    it("skips limit check when limit is 0 (unlimited)", async () => {
      const cache = createTestAuthCache({
        eoaAddress: "0xunlimited",
        usdcBalance: "100000",
        dailySpent: "99999",
        dailyLimit: "0",
        monthlyLimit: "0",
      });
      redis._store.set("auth:0xunlimited", JSON.stringify(cache));

      const { cache: result } = await updateAuthCacheSpend(
        redis as any,
        "0xUNLIMITED",
        1000,
      );

      expect(result).not.toBeNull();
      expect(result!.usdcBalance).toBe("99000");
    });

    it("calls watch on the correct key", async () => {
      const cache = createTestAuthCache({
        eoaAddress: "0xwatched",
        dailyLimit: "0",
        monthlyLimit: "0",
      });
      redis._store.set("auth:0xwatched", JSON.stringify(cache));

      await updateAuthCacheSpend(redis as any, "0xWATCHED", 500);

      expect(redis.watch).toHaveBeenCalledWith("auth:0xwatched");
    });

    it("uses multi/exec for transactional update", async () => {
      const cache = createTestAuthCache({
        eoaAddress: "0xatomic",
        dailyLimit: "0",
        monthlyLimit: "0",
      });
      redis._store.set("auth:0xatomic", JSON.stringify(cache));

      await updateAuthCacheSpend(redis as any, "0xATOMIC", 1000);

      expect(redis.multi).toHaveBeenCalled();
    });

    it("returns null cache when WATCH/MULTI/EXEC transaction fails", async () => {
      const cache = createTestAuthCache({
        eoaAddress: "0xcontended",
        dailyLimit: "0",
        monthlyLimit: "0",
      });
      redis._store.set("auth:0xcontended", JSON.stringify(cache));

      // Override multi to simulate exec returning null (transaction aborted)
      redis.multi.mockReturnValue({
        set: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(null),
      });

      const { cache: result } = await updateAuthCacheSpend(
        redis as any,
        "0xCONTENDED",
        1000,
      );

      expect(result).toBeNull();
    });
  });

  // ================================================================
  // getCardMapping / setCardMapping
  // ================================================================

  describe("Card Mapping round-trip", () => {
    it("getCardMapping returns null for missing key", async () => {
      const result = await getCardMapping(redis as any, "nonexistent-card");

      expect(result).toBeNull();
    });

    it("setCardMapping stores and getCardMapping retrieves correctly", async () => {
      const mapping = createTestCardMapping({
        subAccountId: "sub-001",
        tenantId: "tenant-001",
        eoaAddress: "0xabc",
        m2SafeAddress: "0xdef",
        status: "active",
      });

      await setCardMapping(redis as any, "card-token-xyz", mapping);

      const result = await getCardMapping(redis as any, "card-token-xyz");

      expect(result).not.toBeNull();
      expect(result!.subAccountId).toBe("sub-001");
      expect(result!.tenantId).toBe("tenant-001");
      expect(result!.eoaAddress).toBe("0xabc");
      expect(result!.m2SafeAddress).toBe("0xdef");
      expect(result!.status).toBe("active");
    });

    it("round-trips all card statuses correctly", async () => {
      const statuses: CardMapping["status"][] = [
        "active",
        "frozen",
        "cancelled",
      ];

      for (const status of statuses) {
        const mapping = createTestCardMapping({ status });
        const token = `card-${status}`;

        await setCardMapping(redis as any, token, mapping);
        const result = await getCardMapping(redis as any, token);

        expect(result!.status).toBe(status);
      }
    });

    it("overwrites existing mapping for the same card token", async () => {
      const mapping1 = createTestCardMapping({ status: "active" });
      const mapping2 = createTestCardMapping({ status: "frozen" });

      await setCardMapping(redis as any, "card-overwrite", mapping1);
      await setCardMapping(redis as any, "card-overwrite", mapping2);

      const result = await getCardMapping(redis as any, "card-overwrite");
      expect(result!.status).toBe("frozen");
    });

    it("stores to the correct Redis key with TTL", async () => {
      const mapping = createTestCardMapping();

      await setCardMapping(redis as any, "card-abc-123", mapping);

      expect(redis.set).toHaveBeenCalledWith(
        "card:card-abc-123",
        JSON.stringify(mapping),
        "EX",
        86400,
      );
    });

    it("reads from the correct Redis key", async () => {
      await getCardMapping(redis as any, "card-lookup-test");

      expect(redis.get).toHaveBeenCalledWith("card:card-lookup-test");
    });
  });

  // ================================================================
  // checkRateLimit
  // ================================================================

  describe("checkRateLimit", () => {
    it("allows the first request under the limit", async () => {
      const result = await checkRateLimit(redis as any, "tenant-001", 100, 60);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(99); // 100 - 1
    });

    it("allows requests up to the limit", async () => {
      // Set the counter to just under the limit
      // incr returns 1, 2, 3, ... so call it enough times to reach limit
      const limit = 5;

      let lastResult;
      for (let i = 0; i < limit; i++) {
        lastResult = await checkRateLimit(
          redis as any,
          "tenant-002",
          limit,
          60,
        );
      }

      // At exactly the limit, should still be allowed
      expect(lastResult!.allowed).toBe(true);
      expect(lastResult!.remaining).toBe(0);
    });

    it("rejects requests over the limit", async () => {
      const limit = 3;

      // Make limit+1 requests
      let lastResult;
      for (let i = 0; i <= limit; i++) {
        lastResult = await checkRateLimit(
          redis as any,
          "tenant-003",
          limit,
          60,
        );
      }

      // The (limit+1)th request should be rejected
      expect(lastResult!.allowed).toBe(false);
      expect(lastResult!.remaining).toBe(0);
    });

    it("uses INCR to atomically increment the counter", async () => {
      await checkRateLimit(redis as any, "tenant-004", 100, 60);

      expect(redis.incr).toHaveBeenCalled();
    });

    it("sets TTL on the key when counter is 1 (first request in window)", async () => {
      await checkRateLimit(redis as any, "tenant-005", 100, 60);

      // First incr returns 1, so expire should be called
      expect(redis.expire).toHaveBeenCalled();
    });

    it("does not reset TTL on subsequent requests in same window", async () => {
      // First request: incr returns 1, sets expire
      await checkRateLimit(redis as any, "tenant-006", 100, 60);
      expect(redis.expire).toHaveBeenCalledTimes(1);

      // Second request: incr returns 2, should NOT set expire again
      await checkRateLimit(redis as any, "tenant-006", 100, 60);
      // expire should still have been called only once because
      // incr returns 2 the second time, and the code only calls expire
      // when current === 1
      expect(redis.expire).toHaveBeenCalledTimes(1);
    });

    it("returns remaining count correctly", async () => {
      const limit = 10;

      const result1 = await checkRateLimit(
        redis as any,
        "tenant-007",
        limit,
        60,
      );
      expect(result1.remaining).toBe(9);

      const result2 = await checkRateLimit(
        redis as any,
        "tenant-007",
        limit,
        60,
      );
      expect(result2.remaining).toBe(8);
    });

    it("remaining never goes below zero", async () => {
      const limit = 2;

      await checkRateLimit(redis as any, "tenant-008", limit, 60); // 1
      await checkRateLimit(redis as any, "tenant-008", limit, 60); // 2
      const result = await checkRateLimit(
        redis as any,
        "tenant-008",
        limit,
        60,
      ); // 3

      expect(result.remaining).toBe(0); // Math.max(0, 2 - 3) = 0
      expect(result.allowed).toBe(false);
    });

    it("uses windowSeconds to determine the key suffix", async () => {
      await checkRateLimit(redis as any, "tenant-009", 100, 120);

      // The key should be rate:tenant-009:{window} where window = floor(now/120)
      const expectedWindow = Math.floor(Math.floor(Date.now() / 1000) / 120);
      const expectedKey = `rate:tenant-009:${expectedWindow}`;

      expect(redis.incr).toHaveBeenCalledWith(expectedKey);
    });

    it("isolates rate limits per tenant", async () => {
      const result1 = await checkRateLimit(redis as any, "tenant-A", 5, 60);
      const result2 = await checkRateLimit(redis as any, "tenant-B", 5, 60);

      // Both should be at 1 request each (independent counters)
      expect(result1.remaining).toBe(4);
      expect(result2.remaining).toBe(4);
    });
  });
});
