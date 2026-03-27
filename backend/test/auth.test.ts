/**
 * Test suite for the requireAuth middleware.
 *
 * Covers: missing/invalid API key, tenant status checks, successful auth,
 * DB error handling, and the dev bypass via X-Test-Tenant-Id.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { requireAuth } from "../src/middleware/auth.js";
import { createMockPrisma, type MockPrismaClient } from "./mocks.js";

// ============ Helpers ============

function createMockReq(headers: Record<string, string> = {}) {
  return { headers } as any;
}

function createMockRes() {
  const res: any = {
    _status: 0,
    _json: null as any,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(body: any) {
      res._json = body;
      return res;
    },
  };
  return res;
}

describe("requireAuth middleware", () => {
  let prisma: MockPrismaClient;
  let middleware: ReturnType<typeof requireAuth>;
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    prisma = createMockPrisma();
    middleware = requireAuth(prisma as any);
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  // ================================================================
  // Missing / empty API key
  // ================================================================

  it("returns 401 when X-API-Key header is missing", async () => {
    const req = createMockReq({});
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res._status).toBe(401);
    expect(res._json).toEqual({ error: "Missing or invalid X-API-Key header" });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when X-API-Key header is empty", async () => {
    const req = createMockReq({ "x-api-key": "" });
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res._status).toBe(401);
    expect(res._json).toEqual({ error: "Missing or invalid X-API-Key header" });
    expect(next).not.toHaveBeenCalled();
  });

  // ================================================================
  // API key not found in DB
  // ================================================================

  it("returns 401 when API key is not found in DB", async () => {
    prisma.tenant.findUnique.mockResolvedValue(null);

    const req = createMockReq({ "x-api-key": "sk_unknown_key" });
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res._status).toBe(401);
    expect(res._json).toEqual({ error: "Invalid API key" });
    expect(next).not.toHaveBeenCalled();

    // Verify it hashed the key with SHA-256
    const expectedHash = createHash("sha256")
      .update("sk_unknown_key")
      .digest("hex");
    expect(prisma.tenant.findUnique).toHaveBeenCalledWith({
      where: { apiKeyHash: expectedHash },
      select: { id: true, status: true, rateLimit: true },
    });
  });

  // ================================================================
  // Tenant status checks
  // ================================================================

  it("returns 403 when tenant is suspended", async () => {
    const apiKey = "sk_suspended_tenant";
    const hash = createHash("sha256").update(apiKey).digest("hex");
    prisma.tenant.findUnique.mockResolvedValue({
      id: "tenant-suspended",
      status: "suspended",
      rateLimit: 1000,
    });

    const req = createMockReq({ "x-api-key": apiKey });
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res._status).toBe(403);
    expect(res._json).toEqual({ error: "Tenant account is suspended" });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 when tenant is disabled", async () => {
    const apiKey = "sk_disabled_tenant";
    prisma.tenant.findUnique.mockResolvedValue({
      id: "tenant-disabled",
      status: "disabled",
      rateLimit: 1000,
    });

    const req = createMockReq({ "x-api-key": apiKey });
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res._status).toBe(403);
    expect(res._json).toEqual({ error: "Tenant account is disabled" });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 for unknown tenant status (generic message)", async () => {
    const apiKey = "sk_weird_status";
    prisma.tenant.findUnique.mockResolvedValue({
      id: "tenant-weird",
      status: "pending_review",
      rateLimit: 1000,
    });

    const req = createMockReq({ "x-api-key": apiKey });
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res._status).toBe(403);
    expect(res._json).toEqual({ error: "Account access denied" });
    expect(next).not.toHaveBeenCalled();
  });

  // ================================================================
  // Successful auth
  // ================================================================

  it("sets tenantId on request when valid key found", async () => {
    const apiKey = "sk_valid_key_123";
    prisma.tenant.findUnique.mockResolvedValue({
      id: "tenant-active",
      status: "active",
      rateLimit: 1000,
    });

    const req = createMockReq({ "x-api-key": apiKey });
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(req.tenantId).toBe("tenant-active");
  });

  it("calls next() on successful authentication", async () => {
    const apiKey = "sk_valid_key_456";
    prisma.tenant.findUnique.mockResolvedValue({
      id: "tenant-ok",
      status: "active",
      rateLimit: 1000,
    });

    const req = createMockReq({ "x-api-key": apiKey });
    const res = createMockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res._status).toBe(0); // status was never set
  });

  // ================================================================
  // DB error handling
  // ================================================================

  it("handles DB errors gracefully with 500", async () => {
    prisma.tenant.findUnique.mockRejectedValue(new Error("DB connection lost"));

    const req = createMockReq({ "x-api-key": "sk_any_key" });
    const res = createMockRes();
    const next = vi.fn();

    // Suppress console.error during this test
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await middleware(req, res, next);

    expect(res._status).toBe(500);
    expect(res._json).toEqual({ error: "Internal authentication error" });
    expect(next).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  // ================================================================
  // Dev bypass via X-Test-Tenant-Id
  // ================================================================

  describe("dev bypass (X-Test-Tenant-Id)", () => {
    it("skips auth when ALLOW_TEST_AUTH=true, NODE_ENV!=production, and tenant exists", async () => {
      process.env.ALLOW_TEST_AUTH = "true";
      process.env.NODE_ENV = "test";

      // First call is for the test tenant lookup (by id)
      prisma.tenant.findUnique.mockResolvedValue({ id: "test-tenant-001" });

      const req = createMockReq({ "x-test-tenant-id": "test-tenant-001" });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(req.tenantId).toBe("test-tenant-001");
      expect(next).toHaveBeenCalledTimes(1);
      expect(prisma.tenant.findUnique).toHaveBeenCalledWith({
        where: { id: "test-tenant-001" },
        select: { id: true },
      });
    });

    it("rejects non-existent test tenant ID and falls through to API key check", async () => {
      process.env.ALLOW_TEST_AUTH = "true";
      process.env.NODE_ENV = "test";

      // Test tenant lookup returns null (not found)
      prisma.tenant.findUnique.mockResolvedValue(null);

      const req = createMockReq({ "x-test-tenant-id": "nonexistent-tenant" });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      // Falls through to normal API key check, which also fails (no X-API-Key)
      expect(res._status).toBe(401);
      expect(res._json).toEqual({
        error: "Missing or invalid X-API-Key header",
      });
      expect(next).not.toHaveBeenCalled();
    });

    it("does NOT bypass auth when NODE_ENV=production", async () => {
      process.env.ALLOW_TEST_AUTH = "true";
      process.env.NODE_ENV = "production";

      const req = createMockReq({ "x-test-tenant-id": "test-tenant-001" });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      // Should fall through to API key check and fail
      expect(res._status).toBe(401);
      expect(res._json).toEqual({
        error: "Missing or invalid X-API-Key header",
      });
      expect(next).not.toHaveBeenCalled();
    });

    it("does NOT bypass auth when ALLOW_TEST_AUTH is not set", async () => {
      delete process.env.ALLOW_TEST_AUTH;
      process.env.NODE_ENV = "test";

      const req = createMockReq({ "x-test-tenant-id": "test-tenant-001" });
      const res = createMockRes();
      const next = vi.fn();

      await middleware(req, res, next);

      // Should fall through to API key check and fail
      expect(res._status).toBe(401);
      expect(res._json).toEqual({
        error: "Missing or invalid X-API-Key header",
      });
      expect(next).not.toHaveBeenCalled();
    });
  });
});
