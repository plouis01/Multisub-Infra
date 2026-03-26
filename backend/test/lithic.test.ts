/**
 * Test suite for the LithicClient (using MockLithicClient).
 *
 * Covers: card creation (virtual/physical), card retrieval, card state
 * updates (freeze/unfreeze), webhook signature verification, and ASA
 * event parsing with Zod validation.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  LithicClient,
  MockLithicClient,
  LithicApiError,
  LithicWebhookError,
} from "../src/integrations/lithic.js";
import type { LithicASAEvent } from "../src/types/index.js";

describe("LithicClient (MockLithicClient)", () => {
  let client: MockLithicClient;
  const webhookSecret = "test-webhook-secret-abc123";

  beforeEach(() => {
    client = new MockLithicClient(webhookSecret, {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    });
  });

  // ================================================================
  // Card Creation
  // ================================================================

  describe("createCard", () => {
    it("creates a virtual card with OPEN state", async () => {
      const card = await client.createCard({
        type: "virtual",
        spendLimit: 500000, // $5,000
        memo: "Employee card",
      });

      expect(card.token).toBe("mock-card-000001");
      expect(card.type).toBe("VIRTUAL");
      expect(card.state).toBe("OPEN");
      expect(card.spend_limit).toBe(500000);
      expect(card.memo).toBe("Employee card");
      expect(card.pan).toBeDefined();
      expect(card.cvv).toBe("123");
      expect(card.exp_month).toBe("12");
      expect(card.exp_year).toBe("2028");
      expect(card.last_four).toHaveLength(4);
      expect(card.created).toBeDefined();
    });

    it("creates a physical card with PENDING_FULFILLMENT state", async () => {
      const card = await client.createCard({
        type: "physical",
        spendLimit: 1000000,
      });

      expect(card.token).toBe("mock-card-000001");
      expect(card.type).toBe("PHYSICAL");
      expect(card.state).toBe("PENDING_FULFILLMENT");
      expect(card.spend_limit).toBe(1000000);
      expect(card.memo).toBe("");
    });

    it("generates unique tokens for multiple cards", async () => {
      const card1 = await client.createCard({
        type: "virtual",
        spendLimit: 100000,
      });
      const card2 = await client.createCard({
        type: "virtual",
        spendLimit: 200000,
      });
      const card3 = await client.createCard({
        type: "physical",
        spendLimit: 300000,
      });

      expect(card1.token).toBe("mock-card-000001");
      expect(card2.token).toBe("mock-card-000002");
      expect(card3.token).toBe("mock-card-000003");
      expect(client.cardCount).toBe(3);
    });

    it("generates a 16-digit PAN starting with 4000", async () => {
      const card = await client.createCard({
        type: "virtual",
        spendLimit: 100000,
      });

      expect(card.pan).toBeDefined();
      expect(card.pan!.length).toBe(16);
      expect(card.pan!.startsWith("4000")).toBe(true);
      expect(card.last_four).toBe(card.pan!.slice(-4));
    });
  });

  // ================================================================
  // Card Retrieval
  // ================================================================

  describe("getCard", () => {
    it("retrieves an existing card by token", async () => {
      const created = await client.createCard({
        type: "virtual",
        spendLimit: 250000,
        memo: "Test card",
      });

      const retrieved = await client.getCard(created.token);

      expect(retrieved.token).toBe(created.token);
      expect(retrieved.type).toBe("VIRTUAL");
      expect(retrieved.state).toBe("OPEN");
      expect(retrieved.spend_limit).toBe(250000);
      expect(retrieved.memo).toBe("Test card");
    });

    it("throws LithicApiError (404) for non-existent card", async () => {
      await expect(client.getCard("nonexistent-token")).rejects.toThrow(
        LithicApiError,
      );

      try {
        await client.getCard("nonexistent-token");
      } catch (error) {
        expect(error).toBeInstanceOf(LithicApiError);
        expect((error as LithicApiError).statusCode).toBe(404);
      }
    });

    it("throws when card token is empty", async () => {
      await expect(client.getCard("")).rejects.toThrow(
        "Card token is required",
      );
    });

    it("returns a copy (does not expose internal state)", async () => {
      const created = await client.createCard({
        type: "virtual",
        spendLimit: 100000,
      });

      const retrieved1 = await client.getCard(created.token);
      const retrieved2 = await client.getCard(created.token);

      // Should be equal but not the same object reference
      expect(retrieved1).toEqual(retrieved2);
      expect(retrieved1).not.toBe(retrieved2);
    });
  });

  // ================================================================
  // Card Updates (freeze / unfreeze / close)
  // ================================================================

  describe("updateCard", () => {
    it("freezes a card (state -> PAUSED)", async () => {
      const card = await client.createCard({
        type: "virtual",
        spendLimit: 100000,
      });
      expect(card.state).toBe("OPEN");

      const updated = await client.updateCard(card.token, { state: "PAUSED" });

      expect(updated.state).toBe("PAUSED");
      expect(updated.token).toBe(card.token);

      // Verify persistence
      const refetched = await client.getCard(card.token);
      expect(refetched.state).toBe("PAUSED");
    });

    it("unfreezes a card (state -> OPEN)", async () => {
      const card = await client.createCard({
        type: "virtual",
        spendLimit: 100000,
      });
      await client.updateCard(card.token, { state: "PAUSED" });

      const updated = await client.updateCard(card.token, { state: "OPEN" });

      expect(updated.state).toBe("OPEN");
    });

    it("closes a card (state -> CLOSED)", async () => {
      const card = await client.createCard({
        type: "virtual",
        spendLimit: 100000,
      });

      const updated = await client.updateCard(card.token, { state: "CLOSED" });

      expect(updated.state).toBe("CLOSED");
    });

    it("throws when updating a closed card", async () => {
      const card = await client.createCard({
        type: "virtual",
        spendLimit: 100000,
      });
      await client.updateCard(card.token, { state: "CLOSED" });

      await expect(
        client.updateCard(card.token, { state: "OPEN" }),
      ).rejects.toThrow(LithicApiError);

      try {
        await client.updateCard(card.token, { state: "OPEN" });
      } catch (error) {
        expect((error as LithicApiError).statusCode).toBe(400);
      }
    });

    it("updates spend limit", async () => {
      const card = await client.createCard({
        type: "virtual",
        spendLimit: 100000,
      });

      const updated = await client.updateCard(card.token, {
        spendLimit: 200000,
      });

      expect(updated.spend_limit).toBe(200000);
      expect(updated.state).toBe("OPEN"); // state unchanged
    });

    it("updates both state and spend limit simultaneously", async () => {
      const card = await client.createCard({
        type: "virtual",
        spendLimit: 100000,
      });

      const updated = await client.updateCard(card.token, {
        state: "PAUSED",
        spendLimit: 50000,
      });

      expect(updated.state).toBe("PAUSED");
      expect(updated.spend_limit).toBe(50000);
    });

    it("throws LithicApiError (404) for non-existent card", async () => {
      await expect(
        client.updateCard("nonexistent", { state: "PAUSED" }),
      ).rejects.toThrow(LithicApiError);
    });

    it("throws when card token is empty", async () => {
      await expect(client.updateCard("", { state: "PAUSED" })).rejects.toThrow(
        "Card token is required",
      );
    });
  });

  // ================================================================
  // Webhook Signature Verification
  // ================================================================

  describe("verifyWebhookSignature", () => {
    it("verifies a valid HMAC-SHA256 signature", () => {
      const payload = JSON.stringify({
        token: "tx-001",
        card_token: "card-001",
        amount: 1500,
      });

      const signature = createHmac("sha256", webhookSecret)
        .update(payload, "utf8")
        .digest("hex");

      expect(client.verifyWebhookSignature(payload, signature)).toBe(true);
    });

    it("verifies signature using the signPayload helper", () => {
      const payload = '{"test":"data"}';
      const signature = client.signPayload(payload);

      expect(client.verifyWebhookSignature(payload, signature)).toBe(true);
    });

    it("rejects an invalid signature", () => {
      const payload = '{"test":"data"}';
      const wrongSignature = createHmac("sha256", "wrong-secret")
        .update(payload, "utf8")
        .digest("hex");

      expect(client.verifyWebhookSignature(payload, wrongSignature)).toBe(
        false,
      );
    });

    it("rejects a tampered payload", () => {
      const originalPayload = '{"amount":1500}';
      const signature = client.signPayload(originalPayload);

      const tamperedPayload = '{"amount":9999}';

      expect(client.verifyWebhookSignature(tamperedPayload, signature)).toBe(
        false,
      );
    });

    it("rejects empty payload", () => {
      expect(client.verifyWebhookSignature("", "abcdef")).toBe(false);
    });

    it("rejects empty signature", () => {
      expect(client.verifyWebhookSignature('{"test":"data"}', "")).toBe(false);
    });

    it("rejects malformed (non-hex) signature gracefully", () => {
      const payload = '{"test":"data"}';

      // Non-hex string that would cause Buffer.from to produce different length
      expect(
        client.verifyWebhookSignature(payload, "not-a-hex-signature!!!"),
      ).toBe(false);
    });
  });

  // ================================================================
  // ASA Event Parsing
  // ================================================================

  describe("parseASAEvent", () => {
    it("parses a valid AUTHORIZATION event", () => {
      const raw = {
        token: "tx-abc-123",
        card_token: "card-def-456",
        status: "AUTHORIZATION",
        amount: 2500,
        merchant: {
          descriptor: "ACME STORE",
          mcc: "5411",
          city: "SAN FRANCISCO",
          country: "US",
        },
        created: "2025-06-15T10:30:00+00:00",
      };

      const event = client.parseASAEvent(raw);

      expect(event.token).toBe("tx-abc-123");
      expect(event.card_token).toBe("card-def-456");
      expect(event.status).toBe("AUTHORIZATION");
      expect(event.amount).toBe(2500);
      expect(event.merchant.descriptor).toBe("ACME STORE");
      expect(event.merchant.mcc).toBe("5411");
      expect(event.created).toBe("2025-06-15T10:30:00+00:00");
    });

    it("parses all valid status types", () => {
      const statuses = [
        "AUTHORIZATION",
        "AUTHORIZATION_ADVICE",
        "CLEARING",
        "VOID",
      ] as const;

      for (const status of statuses) {
        const raw = {
          token: "tx-001",
          card_token: "card-001",
          status,
          amount: 1000,
          merchant: { descriptor: "TEST", mcc: "5411" },
          created: "2025-06-15T10:30:00+00:00",
        };

        const event = client.parseASAEvent(raw);
        expect(event.status).toBe(status);
      }
    });

    it("parses events with optional merchant fields omitted", () => {
      const raw = {
        token: "tx-001",
        card_token: "card-001",
        status: "AUTHORIZATION",
        amount: 1000,
        merchant: {
          descriptor: "ONLINE STORE",
          mcc: "5999",
          // city and country omitted
        },
        created: "2025-06-15T10:30:00+00:00",
      };

      const event = client.parseASAEvent(raw);
      expect(event.merchant.city).toBeUndefined();
      expect(event.merchant.country).toBeUndefined();
    });

    it("rejects event with missing token", () => {
      const raw = {
        // token missing
        card_token: "card-001",
        status: "AUTHORIZATION",
        amount: 1000,
        merchant: { descriptor: "TEST", mcc: "5411" },
        created: "2025-06-15T10:30:00+00:00",
      };

      expect(() => client.parseASAEvent(raw)).toThrow(LithicWebhookError);
    });

    it("rejects event with empty token", () => {
      const raw = {
        token: "",
        card_token: "card-001",
        status: "AUTHORIZATION",
        amount: 1000,
        merchant: { descriptor: "TEST", mcc: "5411" },
        created: "2025-06-15T10:30:00+00:00",
      };

      expect(() => client.parseASAEvent(raw)).toThrow(LithicWebhookError);
    });

    it("rejects event with missing card_token", () => {
      const raw = {
        token: "tx-001",
        // card_token missing
        status: "AUTHORIZATION",
        amount: 1000,
        merchant: { descriptor: "TEST", mcc: "5411" },
        created: "2025-06-15T10:30:00+00:00",
      };

      expect(() => client.parseASAEvent(raw)).toThrow(LithicWebhookError);
    });

    it("rejects event with invalid status", () => {
      const raw = {
        token: "tx-001",
        card_token: "card-001",
        status: "INVALID_STATUS",
        amount: 1000,
        merchant: { descriptor: "TEST", mcc: "5411" },
        created: "2025-06-15T10:30:00+00:00",
      };

      expect(() => client.parseASAEvent(raw)).toThrow(LithicWebhookError);
    });

    it("rejects event with non-integer amount", () => {
      const raw = {
        token: "tx-001",
        card_token: "card-001",
        status: "AUTHORIZATION",
        amount: 15.99, // Not an integer
        merchant: { descriptor: "TEST", mcc: "5411" },
        created: "2025-06-15T10:30:00+00:00",
      };

      expect(() => client.parseASAEvent(raw)).toThrow(LithicWebhookError);
    });

    it("rejects event with missing merchant", () => {
      const raw = {
        token: "tx-001",
        card_token: "card-001",
        status: "AUTHORIZATION",
        amount: 1000,
        // merchant missing
        created: "2025-06-15T10:30:00+00:00",
      };

      expect(() => client.parseASAEvent(raw)).toThrow(LithicWebhookError);
    });

    it("rejects event with invalid created date", () => {
      const raw = {
        token: "tx-001",
        card_token: "card-001",
        status: "AUTHORIZATION",
        amount: 1000,
        merchant: { descriptor: "TEST", mcc: "5411" },
        created: "not-a-date",
      };

      expect(() => client.parseASAEvent(raw)).toThrow(LithicWebhookError);
    });

    it("rejects completely malformed input", () => {
      expect(() => client.parseASAEvent(null)).toThrow(LithicWebhookError);
      expect(() => client.parseASAEvent(undefined)).toThrow(LithicWebhookError);
      expect(() => client.parseASAEvent("string")).toThrow(LithicWebhookError);
      expect(() => client.parseASAEvent(42)).toThrow(LithicWebhookError);
    });

    it("includes field paths in error messages", () => {
      const raw = {
        token: "tx-001",
        card_token: "card-001",
        status: "BAD",
        amount: "not-a-number",
        merchant: { descriptor: "TEST", mcc: "5411" },
        created: "2025-06-15T10:30:00+00:00",
      };

      try {
        client.parseASAEvent(raw);
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(LithicWebhookError);
        expect((error as LithicWebhookError).message).toContain(
          "Invalid ASA event payload",
        );
      }
    });
  });

  // ================================================================
  // MockLithicClient Helpers
  // ================================================================

  describe("MockLithicClient helpers", () => {
    it("buildASAEvent creates a valid event with defaults", () => {
      const event = client.buildASAEvent();

      expect(event.token).toBeDefined();
      expect(event.card_token).toBe("mock-card-000001");
      expect(event.status).toBe("AUTHORIZATION");
      expect(event.amount).toBe(1500);
      expect(event.merchant.descriptor).toBe("ACME WIDGETS");
      expect(event.merchant.mcc).toBe("5411");
      expect(event.created).toBeDefined();
    });

    it("buildASAEvent accepts overrides", () => {
      const event = client.buildASAEvent({
        amount: 9999,
        status: "CLEARING",
        card_token: "custom-card",
      });

      expect(event.amount).toBe(9999);
      expect(event.status).toBe("CLEARING");
      expect(event.card_token).toBe("custom-card");
    });

    it("reset clears all cards", async () => {
      await client.createCard({ type: "virtual", spendLimit: 100000 });
      await client.createCard({ type: "virtual", spendLimit: 200000 });
      expect(client.cardCount).toBe(2);

      client.reset();

      expect(client.cardCount).toBe(0);
    });

    it("reset resets token counter", async () => {
      await client.createCard({ type: "virtual", spendLimit: 100000 });
      expect(
        (await client.createCard({ type: "virtual", spendLimit: 100000 }))
          .token,
      ).toBe("mock-card-000002");

      client.reset();

      const card = await client.createCard({
        type: "virtual",
        spendLimit: 100000,
      });
      expect(card.token).toBe("mock-card-000001");
    });

    it("signPayload produces consistent signatures", () => {
      const payload = '{"test":"consistency"}';
      const sig1 = client.signPayload(payload);
      const sig2 = client.signPayload(payload);

      expect(sig1).toBe(sig2);
    });
  });

  // ================================================================
  // Constructor Validation
  // ================================================================

  describe("constructor", () => {
    it("throws when API key is empty", () => {
      expect(() => {
        new LithicClient("", "secret", "sandbox");
      }).toThrow("Lithic API key is required");
    });

    it("throws when webhook secret is empty", () => {
      expect(() => {
        new LithicClient("api-key", "", "sandbox");
      }).toThrow("Lithic webhook secret is required");
    });
  });
});
