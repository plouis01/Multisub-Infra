/**
 * Test suite for the SumsubClient (using MockSumsubClient).
 *
 * Covers: applicant creation, applicant retrieval, applicant status,
 * access token creation, webhook signature verification, webhook event
 * building, and test helpers (approve/reject).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  SumsubClient,
  MockSumsubClient,
  SumsubApiError,
} from "../src/integrations/kyc.js";
import type { KycWebhookEvent } from "../src/integrations/kyc.js";

describe("SumsubClient (MockSumsubClient)", () => {
  let client: MockSumsubClient;
  const secretKey = "test-sumsub-secret-abc123";

  beforeEach(() => {
    client = new MockSumsubClient(secretKey, {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    });
  });

  // ================================================================
  // Applicant Creation
  // ================================================================

  describe("createApplicant", () => {
    it("creates an applicant with init status", async () => {
      const applicant = await client.createApplicant({
        externalUserId: "ext-user-001",
        email: "user@example.com",
        levelName: "basic-kyc-level",
      });

      expect(applicant.id).toBe("mock-applicant-000001");
      expect(applicant.externalUserId).toBe("ext-user-001");
      expect(applicant.email).toBe("user@example.com");
      expect(applicant.status).toBe("init");
      expect(applicant.createdAt).toBeDefined();
    });

    it("creates an applicant without optional email", async () => {
      const applicant = await client.createApplicant({
        externalUserId: "ext-user-002",
      });

      expect(applicant.id).toBe("mock-applicant-000001");
      expect(applicant.externalUserId).toBe("ext-user-002");
      expect(applicant.email).toBeUndefined();
      expect(applicant.status).toBe("init");
    });

    it("returns existing applicant for duplicate externalUserId", async () => {
      const first = await client.createApplicant({
        externalUserId: "ext-user-001",
        email: "user@example.com",
      });

      const second = await client.createApplicant({
        externalUserId: "ext-user-001",
        email: "different@example.com",
      });

      expect(second.id).toBe(first.id);
      expect(second.externalUserId).toBe(first.externalUserId);
      expect(client.applicantCount).toBe(1);
    });

    it("generates unique IDs for multiple applicants", async () => {
      const a1 = await client.createApplicant({
        externalUserId: "ext-001",
      });
      const a2 = await client.createApplicant({
        externalUserId: "ext-002",
      });
      const a3 = await client.createApplicant({
        externalUserId: "ext-003",
      });

      expect(a1.id).toBe("mock-applicant-000001");
      expect(a2.id).toBe("mock-applicant-000002");
      expect(a3.id).toBe("mock-applicant-000003");
      expect(client.applicantCount).toBe(3);
    });
  });

  // ================================================================
  // Applicant Retrieval
  // ================================================================

  describe("getApplicant", () => {
    it("retrieves an existing applicant by ID", async () => {
      const created = await client.createApplicant({
        externalUserId: "ext-user-001",
        email: "user@example.com",
      });

      const retrieved = await client.getApplicant(created.id);

      expect(retrieved.id).toBe(created.id);
      expect(retrieved.externalUserId).toBe("ext-user-001");
      expect(retrieved.email).toBe("user@example.com");
      expect(retrieved.status).toBe("init");
    });

    it("throws SumsubApiError (404) for non-existent applicant", async () => {
      await expect(client.getApplicant("nonexistent-id")).rejects.toThrow(
        SumsubApiError,
      );

      try {
        await client.getApplicant("nonexistent-id");
      } catch (error) {
        expect(error).toBeInstanceOf(SumsubApiError);
        expect((error as SumsubApiError).statusCode).toBe(404);
      }
    });

    it("throws when applicant ID is empty", async () => {
      await expect(client.getApplicant("")).rejects.toThrow(
        "Applicant ID is required",
      );
    });
  });

  // ================================================================
  // Applicant Status
  // ================================================================

  describe("getApplicantStatus", () => {
    it("returns init status for newly created applicant", async () => {
      const applicant = await client.createApplicant({
        externalUserId: "ext-user-001",
      });

      const status = await client.getApplicantStatus(applicant.id);

      expect(status.reviewStatus).toBe("init");
      expect(status.reviewResult).toBeUndefined();
      expect(status.createDate).toBeDefined();
    });

    it("returns completed status with GREEN result after approval", async () => {
      const applicant = await client.createApplicant({
        externalUserId: "ext-user-001",
      });

      client.approveApplicant(applicant.id);

      const status = await client.getApplicantStatus(applicant.id);

      expect(status.reviewStatus).toBe("completed");
      expect(status.reviewResult).toBeDefined();
      expect(status.reviewResult!.reviewAnswer).toBe("GREEN");
    });

    it("returns completed status with RED result after rejection", async () => {
      const applicant = await client.createApplicant({
        externalUserId: "ext-user-001",
      });

      client.rejectApplicant(applicant.id);

      const status = await client.getApplicantStatus(applicant.id);

      expect(status.reviewStatus).toBe("completed");
      expect(status.reviewResult).toBeDefined();
      expect(status.reviewResult!.reviewAnswer).toBe("RED");
    });

    it("throws SumsubApiError (404) for non-existent applicant", async () => {
      await expect(client.getApplicantStatus("nonexistent-id")).rejects.toThrow(
        SumsubApiError,
      );
    });

    it("throws when applicant ID is empty", async () => {
      await expect(client.getApplicantStatus("")).rejects.toThrow(
        "Applicant ID is required",
      );
    });
  });

  // ================================================================
  // Access Token Creation
  // ================================================================

  describe("createAccessToken", () => {
    it("creates a deterministic access token", async () => {
      const result = await client.createAccessToken(
        "ext-user-001",
        "basic-kyc-level",
      );

      expect(result.token).toBe("mock-access-token-ext-user-001");
      expect(result.userId).toBe("ext-user-001");
    });

    it("creates token without optional levelName", async () => {
      const result = await client.createAccessToken("ext-user-002");

      expect(result.token).toBe("mock-access-token-ext-user-002");
      expect(result.userId).toBe("ext-user-002");
    });

    it("throws when external user ID is empty", async () => {
      await expect(client.createAccessToken("")).rejects.toThrow(
        "External user ID is required",
      );
    });
  });

  // ================================================================
  // Applicant Reset
  // ================================================================

  describe("resetApplicant", () => {
    it("resets applicant status back to init", async () => {
      const applicant = await client.createApplicant({
        externalUserId: "ext-user-001",
      });

      client.approveApplicant(applicant.id);

      let status = await client.getApplicantStatus(applicant.id);
      expect(status.reviewStatus).toBe("completed");

      await client.resetApplicant(applicant.id);

      status = await client.getApplicantStatus(applicant.id);
      expect(status.reviewStatus).toBe("init");
      expect(status.reviewResult).toBeUndefined();
    });

    it("throws SumsubApiError (404) for non-existent applicant", async () => {
      await expect(client.resetApplicant("nonexistent-id")).rejects.toThrow(
        SumsubApiError,
      );
    });

    it("throws when applicant ID is empty", async () => {
      await expect(client.resetApplicant("")).rejects.toThrow(
        "Applicant ID is required",
      );
    });
  });

  // ================================================================
  // Webhook Signature Verification
  // ================================================================

  describe("verifyWebhookSignature", () => {
    it("verifies a valid HMAC-SHA256 signature", () => {
      const payload = JSON.stringify({
        applicantId: "app-001",
        externalUserId: "ext-001",
        type: "applicantReviewed",
      });

      const signature = createHmac("sha256", secretKey)
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
      const originalPayload = '{"applicantId":"app-001"}';
      const signature = client.signPayload(originalPayload);

      const tamperedPayload = '{"applicantId":"app-999"}';

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

      expect(
        client.verifyWebhookSignature(payload, "not-a-hex-signature!!!"),
      ).toBe(false);
    });
  });

  // ================================================================
  // Webhook Event Parsing
  // ================================================================

  describe("buildWebhookEvent", () => {
    it("creates a valid webhook event with defaults", () => {
      const event = client.buildWebhookEvent();

      expect(event.applicantId).toBe("mock-applicant-000001");
      expect(event.externalUserId).toBe("ext-user-001");
      expect(event.type).toBe("applicantReviewed");
      expect(event.reviewResult).toBeDefined();
      expect(event.reviewResult!.reviewAnswer).toBe("GREEN");
      expect(event.createdAt).toBeDefined();
    });

    it("accepts overrides for all fields", () => {
      const event = client.buildWebhookEvent({
        applicantId: "custom-app-id",
        externalUserId: "custom-ext-id",
        type: "applicantPending",
        reviewResult: { reviewAnswer: "YELLOW" },
      });

      expect(event.applicantId).toBe("custom-app-id");
      expect(event.externalUserId).toBe("custom-ext-id");
      expect(event.type).toBe("applicantPending");
      expect(event.reviewResult!.reviewAnswer).toBe("YELLOW");
    });

    it("webhook event can be signed and verified", () => {
      const event = client.buildWebhookEvent();
      const payload = JSON.stringify(event);
      const signature = client.signPayload(payload);

      expect(client.verifyWebhookSignature(payload, signature)).toBe(true);
    });

    it("produces events with all valid types", () => {
      const types = [
        "applicantReviewed",
        "applicantPending",
        "applicantCreated",
        "applicantOnHold",
      ] as const;

      for (const type of types) {
        const event = client.buildWebhookEvent({ type });
        expect(event.type).toBe(type);
      }
    });

    it("produces events with all valid review results", () => {
      const results = ["GREEN", "RED", "YELLOW"] as const;

      for (const reviewAnswer of results) {
        const event = client.buildWebhookEvent({
          reviewResult: { reviewAnswer },
        });
        expect(event.reviewResult!.reviewAnswer).toBe(reviewAnswer);
      }
    });
  });

  // ================================================================
  // Test Helpers (approve / reject)
  // ================================================================

  describe("approveApplicant / rejectApplicant", () => {
    it("approveApplicant sets GREEN result", async () => {
      const applicant = await client.createApplicant({
        externalUserId: "ext-user-001",
      });

      client.approveApplicant(applicant.id);

      const status = await client.getApplicantStatus(applicant.id);
      expect(status.reviewStatus).toBe("completed");
      expect(status.reviewResult!.reviewAnswer).toBe("GREEN");
    });

    it("rejectApplicant sets RED result", async () => {
      const applicant = await client.createApplicant({
        externalUserId: "ext-user-001",
      });

      client.rejectApplicant(applicant.id);

      const status = await client.getApplicantStatus(applicant.id);
      expect(status.reviewStatus).toBe("completed");
      expect(status.reviewResult!.reviewAnswer).toBe("RED");
    });

    it("approveApplicant throws for non-existent applicant", () => {
      expect(() => client.approveApplicant("nonexistent")).toThrow(
        "Applicant not found",
      );
    });

    it("rejectApplicant throws for non-existent applicant", () => {
      expect(() => client.rejectApplicant("nonexistent")).toThrow(
        "Applicant not found",
      );
    });
  });

  // ================================================================
  // MockSumsubClient Reset
  // ================================================================

  describe("reset", () => {
    it("clears all applicants", async () => {
      await client.createApplicant({ externalUserId: "ext-001" });
      await client.createApplicant({ externalUserId: "ext-002" });
      expect(client.applicantCount).toBe(2);

      client.reset();

      expect(client.applicantCount).toBe(0);
    });

    it("resets the ID counter", async () => {
      await client.createApplicant({ externalUserId: "ext-001" });
      expect(
        (await client.createApplicant({ externalUserId: "ext-002" })).id,
      ).toBe("mock-applicant-000002");

      client.reset();

      const applicant = await client.createApplicant({
        externalUserId: "ext-003",
      });
      expect(applicant.id).toBe("mock-applicant-000001");
    });

    it("allows re-creation of previously used externalUserIds", async () => {
      await client.createApplicant({ externalUserId: "ext-001" });
      client.reset();

      const applicant = await client.createApplicant({
        externalUserId: "ext-001",
      });
      expect(applicant.id).toBe("mock-applicant-000001");
      expect(client.applicantCount).toBe(1);
    });
  });

  // ================================================================
  // Constructor Validation
  // ================================================================

  describe("constructor", () => {
    it("throws when app token is empty", () => {
      expect(() => {
        new SumsubClient("", "secret");
      }).toThrow("Sumsub app token is required");
    });

    it("throws when secret key is empty", () => {
      expect(() => {
        new SumsubClient("app-token", "");
      }).toThrow("Sumsub secret key is required");
    });
  });

  // ================================================================
  // signPayload Consistency
  // ================================================================

  describe("signPayload", () => {
    it("produces consistent signatures", () => {
      const payload = '{"test":"consistency"}';
      const sig1 = client.signPayload(payload);
      const sig2 = client.signPayload(payload);

      expect(sig1).toBe(sig2);
    });

    it("produces different signatures for different payloads", () => {
      const sig1 = client.signPayload('{"a":1}');
      const sig2 = client.signPayload('{"a":2}');

      expect(sig1).not.toBe(sig2);
    });
  });
});
