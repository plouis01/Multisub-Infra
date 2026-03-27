/**
 * Test suite for rate limit middleware.
 *
 * Covers: rateLimit (tenant-based) and webhookRateLimit (IP-based).
 * Tests header setting, 429 responses, and fail-open on Redis error.
 *
 * Uses a mock Redis client + mocked checkRateLimit to isolate
 * middleware behavior from the underlying Redis helper (tested in redis.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { rateLimit, webhookRateLimit } from "../src/middleware/rate-limit.js";
import { createMockRedis, type MockRedisClient } from "./mocks.js";

// Mock the checkRateLimit function so we can control its return value
vi.mock("../src/lib/redis.js", () => ({
  checkRateLimit: vi.fn(),
}));

import { checkRateLimit } from "../src/lib/redis.js";
const mockCheckRateLimit = vi.mocked(checkRateLimit);

// ============ Helpers ============

function createMockReq(overrides: Record<string, any> = {}) {
  return {
    headers: {},
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
    ...overrides,
  } as any;
}

function createMockRes() {
  const res: any = {
    _status: 0,
    _json: null as any,
    _headers: {} as Record<string, string>,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(body: any) {
      res._json = body;
      return res;
    },
    setHeader(key: string, value: string | number) {
      res._headers[key] = String(value);
      return res;
    },
  };
  return res;
}

describe("rateLimit middleware", () => {
  let redis: MockRedisClient;

  beforeEach(() => {
    redis = createMockRedis();
    vi.clearAllMocks();
  });

  it("allows request under the limit and sets headers", async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 999 });

    const mw = rateLimit(redis as any, 1000);
    const req = createMockReq({ tenantId: "tenant-001" });
    const res = createMockRes();
    const next = vi.fn();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res._headers["X-RateLimit-Limit"]).toBe("1000");
    expect(res._headers["X-RateLimit-Remaining"]).toBe("999");
    expect(res._status).toBe(0); // no error status set
  });

  it("sets X-RateLimit-Limit and X-RateLimit-Remaining headers", async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 42 });

    const mw = rateLimit(redis as any, 500);
    const req = createMockReq({ tenantId: "tenant-002" });
    const res = createMockRes();
    const next = vi.fn();

    await mw(req, res, next);

    expect(res._headers["X-RateLimit-Limit"]).toBe("500");
    expect(res._headers["X-RateLimit-Remaining"]).toBe("42");
  });

  it("returns 429 when limit is exceeded", async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0 });

    const mw = rateLimit(redis as any, 1000);
    const req = createMockReq({ tenantId: "tenant-003" });
    const res = createMockRes();
    const next = vi.fn();

    await mw(req, res, next);

    expect(res._status).toBe(429);
    expect(res._json).toEqual({
      error: "Rate limit exceeded",
      retryAfter: 60,
    });
    expect(res._headers["Retry-After"]).toBe("60");
    expect(next).not.toHaveBeenCalled();
  });

  it("fails open on Redis error (calls next)", async () => {
    mockCheckRateLimit.mockRejectedValue(new Error("Redis connection refused"));

    const mw = rateLimit(redis as any, 1000);
    const req = createMockReq({ tenantId: "tenant-004" });
    const res = createMockRes();
    const next = vi.fn();

    // Suppress console.error during this test
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res._status).toBe(0); // no error status set

    consoleSpy.mockRestore();
  });

  it("skips rate limiting when tenantId is not set", async () => {
    const mw = rateLimit(redis as any, 1000);
    const req = createMockReq({}); // no tenantId
    const res = createMockRes();
    const next = vi.fn();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });
});

describe("webhookRateLimit middleware", () => {
  let redis: MockRedisClient;

  beforeEach(() => {
    redis = createMockRedis();
    vi.clearAllMocks();
  });

  it("uses IP-based key for rate limiting", async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 299 });

    const mw = webhookRateLimit(redis as any, 300);
    const req = createMockReq({ ip: "192.168.1.100" });
    const res = createMockRes();
    const next = vi.fn();

    await mw(req, res, next);

    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      redis,
      "webhook-ip:192.168.1.100",
      300,
      60,
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("applies correct default limit of 300/min", async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 299 });

    const mw = webhookRateLimit(redis as any); // default 300
    const req = createMockReq({ ip: "10.0.0.1" });
    const res = createMockRes();
    const next = vi.fn();

    await mw(req, res, next);

    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      redis,
      "webhook-ip:10.0.0.1",
      300,
      60,
    );
    expect(res._headers["X-RateLimit-Limit"]).toBe("300");
    expect(res._headers["X-RateLimit-Remaining"]).toBe("299");
  });

  it("returns 429 when webhook rate limit exceeded", async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0 });

    const mw = webhookRateLimit(redis as any, 300);
    const req = createMockReq({ ip: "10.0.0.2" });
    const res = createMockRes();
    const next = vi.fn();

    await mw(req, res, next);

    expect(res._status).toBe(429);
    expect(res._json).toEqual({ error: "Rate limit exceeded" });
    expect(next).not.toHaveBeenCalled();
  });

  it("fails open on Redis error (calls next)", async () => {
    mockCheckRateLimit.mockRejectedValue(new Error("Redis timeout"));

    const mw = webhookRateLimit(redis as any, 300);
    const req = createMockReq({ ip: "10.0.0.3" });
    const res = createMockRes();
    const next = vi.fn();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res._status).toBe(0);
  });

  it("falls back to socket.remoteAddress when req.ip is undefined", async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 299 });

    const mw = webhookRateLimit(redis as any, 300);
    const req = createMockReq({
      ip: undefined,
      socket: { remoteAddress: "172.16.0.1" },
    });
    const res = createMockRes();
    const next = vi.fn();

    await mw(req, res, next);

    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      redis,
      "webhook-ip:172.16.0.1",
      300,
      60,
    );
  });
});
