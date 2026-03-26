/**
 * Test suite for the WebhookDispatcher.
 *
 * Covers: successful dispatch, HMAC signature inclusion, retry behavior,
 * audit logging on permanent failure, and graceful handling of missing
 * webhook URLs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import {
  createMockPrisma,
  createTestTenant,
  createTestWebhookPayload,
  resetIdCounter,
  type MockPrismaClient,
} from "./mocks.js";
import { WebhookDispatcher } from "../src/services/webhook-dispatcher.js";
import type { WebhookPayload } from "../src/types/index.js";

// Capture the real setTimeout so we can control time
const originalFetch = globalThis.fetch;

describe("WebhookDispatcher", () => {
  let prisma: MockPrismaClient;
  let dispatcher: WebhookDispatcher;
  let mockFetch: ReturnType<typeof vi.fn>;

  const testTenant = createTestTenant({
    id: "tenant-001",
    webhookUrl: "https://acme.example.com/webhooks",
    webhookSecret: "whsec_test_secret_1234567890",
  });

  const testPayload: WebhookPayload = createTestWebhookPayload({
    tenantId: "tenant-001",
  });

  beforeEach(() => {
    resetIdCounter();
    prisma = createMockPrisma();
    dispatcher = new WebhookDispatcher(prisma as any);

    // Mock global fetch
    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
    });
    globalThis.fetch = mockFetch;

    // Default: tenant lookup returns valid tenant
    prisma.tenant.findUnique.mockResolvedValue({
      webhookUrl: testTenant.webhookUrl,
      webhookSecret: testTenant.webhookSecret,
    });

    // Stub setTimeout to avoid real delays in retry tests
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ----------------------------------------------------------------
  // Successful dispatch
  // ----------------------------------------------------------------

  it("dispatches event to tenant webhook URL", async () => {
    const dispatchPromise = dispatcher.dispatch("tenant-001", testPayload);
    // No timers to advance since first attempt succeeds
    await dispatchPromise;

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      testTenant.webhookUrl,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(testPayload),
      }),
    );
  });

  it("sends the payload as JSON content type", async () => {
    const dispatchPromise = dispatcher.dispatch("tenant-001", testPayload);
    await dispatchPromise;

    const fetchCall = mockFetch.mock.calls[0];
    const options = fetchCall[1];

    expect(options.headers["Content-Type"]).toBe("application/json");
  });

  // ----------------------------------------------------------------
  // HMAC signature
  // ----------------------------------------------------------------

  it("includes correct HMAC-SHA256 signature header", async () => {
    const dispatchPromise = dispatcher.dispatch("tenant-001", testPayload);
    await dispatchPromise;

    const fetchCall = mockFetch.mock.calls[0];
    const options = fetchCall[1];
    const headers = options.headers;

    // Verify X-Webhook-Signature header exists
    expect(headers["X-Webhook-Signature"]).toBeDefined();

    // Verify X-Webhook-Timestamp header exists
    const timestamp = headers["X-Webhook-Timestamp"];
    expect(timestamp).toBeDefined();

    // Reconstruct the expected signature
    const payload = JSON.stringify(testPayload);
    const signatureInput = `${timestamp}.${payload}`;
    const expectedSignature = createHmac(
      "sha256",
      testTenant.webhookSecret as string,
    )
      .update(signatureInput, "utf8")
      .digest("hex");

    expect(headers["X-Webhook-Signature"]).toBe(expectedSignature);
  });

  it("includes X-Webhook-Timestamp header as unix seconds", async () => {
    const now = Math.floor(Date.now() / 1000);

    const dispatchPromise = dispatcher.dispatch("tenant-001", testPayload);
    await dispatchPromise;

    const fetchCall = mockFetch.mock.calls[0];
    const timestamp = parseInt(fetchCall[1].headers["X-Webhook-Timestamp"], 10);

    // Timestamp should be within a few seconds of now
    expect(timestamp).toBeGreaterThanOrEqual(now - 5);
    expect(timestamp).toBeLessThanOrEqual(now + 5);
  });

  // ----------------------------------------------------------------
  // Retry behavior
  // ----------------------------------------------------------------

  it("retries on failure up to 3 times", async () => {
    // All attempts fail
    mockFetch.mockRejectedValue(new Error("Connection refused"));

    const dispatchPromise = dispatcher.dispatch("tenant-001", testPayload);

    // Advance timers to allow retries
    // After first failure: wait 1000ms
    await vi.advanceTimersByTimeAsync(1_000);
    // After second failure: wait 10000ms
    await vi.advanceTimersByTimeAsync(10_000);
    // Third attempt happens, no more waits

    await dispatchPromise;

    // Should have been called 3 times total (RETRY_DELAYS_MS has 3 entries)
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("stops retrying after first success", async () => {
    // First attempt fails, second succeeds
    mockFetch
      .mockRejectedValueOnce(new Error("Temporary failure"))
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: "OK" });

    const dispatchPromise = dispatcher.dispatch("tenant-001", testPayload);

    // Advance past first retry delay (1000ms)
    await vi.advanceTimersByTimeAsync(1_000);

    await dispatchPromise;

    // Should have been called only twice
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retries on non-2xx HTTP responses", async () => {
    // First two return 500, third succeeds
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
      })
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: "OK" });

    const dispatchPromise = dispatcher.dispatch("tenant-001", testPayload);

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(10_000);

    await dispatchPromise;

    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  // ----------------------------------------------------------------
  // Audit log on permanent failure
  // ----------------------------------------------------------------

  it("logs to audit on permanent failure (all retries exhausted)", async () => {
    mockFetch.mockRejectedValue(new Error("Connection refused"));

    const dispatchPromise = dispatcher.dispatch("tenant-001", testPayload);

    // Advance through all retry delays
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(10_000);

    await dispatchPromise;

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: "tenant-001",
          action: "webhook_delivery_failed",
          details: expect.objectContaining({
            eventId: testPayload.id,
            eventType: testPayload.type,
            webhookUrl: testTenant.webhookUrl,
            error: "Connection refused",
            attempts: 3,
          }),
        }),
      }),
    );
  });

  it("does not log audit when delivery succeeds", async () => {
    const dispatchPromise = dispatcher.dispatch("tenant-001", testPayload);
    await dispatchPromise;

    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("does not crash when audit log write itself fails", async () => {
    mockFetch.mockRejectedValue(new Error("Permanent failure"));
    prisma.auditLog.create.mockRejectedValue(new Error("DB down too"));

    const dispatchPromise = dispatcher.dispatch("tenant-001", testPayload);

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(10_000);

    // Should not throw even though audit log fails
    await expect(dispatchPromise).resolves.toBeUndefined();
  });

  // ----------------------------------------------------------------
  // Missing webhook URL handling
  // ----------------------------------------------------------------

  it("handles missing webhook URL gracefully (no fetch call)", async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      webhookUrl: null,
      webhookSecret: "some-secret",
    });

    const dispatchPromise = dispatcher.dispatch("tenant-001", testPayload);
    await dispatchPromise;

    expect(mockFetch).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("handles tenant not found gracefully", async () => {
    prisma.tenant.findUnique.mockResolvedValue(null);

    const dispatchPromise = dispatcher.dispatch(
      "nonexistent-tenant",
      testPayload,
    );
    await dispatchPromise;

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("handles empty webhook URL gracefully", async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      webhookUrl: "",
      webhookSecret: "some-secret",
    });

    const dispatchPromise = dispatcher.dispatch("tenant-001", testPayload);
    await dispatchPromise;

    // Empty string is falsy, so no fetch should be made
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("skips dispatch when webhook secret is missing", async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      webhookUrl: "https://acme.example.com/webhooks",
      webhookSecret: null,
    });

    const dispatchPromise = dispatcher.dispatch("tenant-001", testPayload);
    await dispatchPromise;

    expect(mockFetch).not.toHaveBeenCalled();
  });

  // ----------------------------------------------------------------
  // Tenant lookup
  // ----------------------------------------------------------------

  it("looks up tenant by the provided tenantId", async () => {
    const dispatchPromise = dispatcher.dispatch("tenant-001", testPayload);
    await dispatchPromise;

    expect(prisma.tenant.findUnique).toHaveBeenCalledWith({
      where: { id: "tenant-001" },
      select: {
        webhookUrl: true,
        webhookSecret: true,
      },
    });
  });

  // ----------------------------------------------------------------
  // Multiple events
  // ----------------------------------------------------------------

  it("dispatches multiple events independently", async () => {
    const payload1 = createTestWebhookPayload({
      type: "card.authorization.approved",
    });
    const payload2 = createTestWebhookPayload({
      type: "card.transaction.settled",
    });

    await dispatcher.dispatch("tenant-001", payload1);
    await dispatcher.dispatch("tenant-001", payload2);

    expect(mockFetch).toHaveBeenCalledTimes(2);

    const firstBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body);

    expect(firstBody.type).toBe("card.authorization.approved");
    expect(secondBody.type).toBe("card.transaction.settled");
  });
});
