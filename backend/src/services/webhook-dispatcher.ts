import { createHmac, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import { getCardMapping } from "../lib/redis.js";
import type { WebhookPayload, WebhookEventType } from "../types/index.js";

// ============ Constants ============

/** Retry delays in milliseconds: 1s, 10s, 60s. */
const RETRY_DELAYS_MS = [1_000, 10_000, 60_000] as const;

const REQUEST_TIMEOUT_MS = 10_000;

// ============ Types ============

interface DispatchInput {
  type: WebhookEventType;
  data: Record<string, unknown>;
}

// ============ Webhook Dispatcher ============

export class WebhookDispatcher {
  private readonly prisma: PrismaClient;
  private readonly redis: Redis | null;

  constructor(prisma: PrismaClient, redis?: Redis) {
    this.prisma = prisma;
    this.redis = redis ?? null;
  }

  /**
   * Dispatch a webhook event to a tenant.
   *
   * Looks up the tenant's webhook URL and secret, signs the payload with
   * HMAC-SHA256, and sends an HTTP POST. Retries up to 3 times with
   * exponential backoff (1s, 10s, 60s). Logs failures to AuditLog.
   */
  async dispatch(tenantId: string, event: WebhookPayload): Promise<void> {
    // Look up tenant's webhook configuration
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        webhookUrl: true,
        webhookSecret: true,
      },
    });

    if (!tenant?.webhookUrl) {
      // Tenant has no webhook configured — nothing to do
      return;
    }

    if (!tenant.webhookSecret) {
      console.warn(
        `[WebhookDispatcher] Tenant ${tenantId} has webhookUrl but no webhookSecret — skipping`,
      );
      return;
    }

    const payload = JSON.stringify(event);
    const timestamp = Math.floor(Date.now() / 1000).toString();

    // Sign the payload: HMAC-SHA256(secret, timestamp.payload)
    const signatureInput = `${timestamp}.${payload}`;
    const signature = createHmac("sha256", tenant.webhookSecret)
      .update(signatureInput, "utf8")
      .digest("hex");

    // Attempt delivery with retries
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
      try {
        await this.sendWebhook(
          tenant.webhookUrl,
          payload,
          signature,
          timestamp,
        );
        return; // Success — done
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        console.warn(
          `[WebhookDispatcher] Delivery attempt ${attempt + 1}/${RETRY_DELAYS_MS.length} failed for tenant ${tenantId}: ${lastError.message}`,
        );

        // Wait before retrying (unless this was the last attempt)
        if (attempt < RETRY_DELAYS_MS.length - 1) {
          await this.sleep(RETRY_DELAYS_MS[attempt]);
        }
      }
    }

    // All retries exhausted — log failure to AuditLog
    console.error(
      `[WebhookDispatcher] All ${RETRY_DELAYS_MS.length} delivery attempts failed for tenant ${tenantId}`,
    );

    try {
      await this.prisma.auditLog.create({
        data: {
          tenantId,
          action: "webhook_delivery_failed",
          details: {
            eventId: event.id,
            eventType: event.type,
            webhookUrl: tenant.webhookUrl,
            error: lastError?.message ?? "Unknown error",
            attempts: RETRY_DELAYS_MS.length,
          },
        },
      });
    } catch (auditError) {
      console.error(
        "[WebhookDispatcher] Failed to log webhook delivery failure to AuditLog:",
        auditError,
      );
    }
  }

  /**
   * Convenience method: dispatch a webhook event by looking up the tenant
   * from a card token (via Redis card mapping).
   */
  async dispatchForCard(
    cardToken: string,
    input: DispatchInput,
  ): Promise<void> {
    if (!this.redis) {
      console.warn(
        "[WebhookDispatcher] No Redis client — cannot look up card mapping",
      );
      return;
    }

    const mapping = await getCardMapping(this.redis, cardToken);
    if (!mapping) {
      console.warn(
        `[WebhookDispatcher] No card mapping found for token ${cardToken}`,
      );
      return;
    }

    const event: WebhookPayload = {
      id: randomUUID(),
      type: input.type,
      tenantId: mapping.tenantId,
      timestamp: Date.now(),
      data: input.data,
    };

    await this.dispatch(mapping.tenantId, event);
  }

  // ============ Private Helpers ============

  private async sendWebhook(
    url: string,
    payload: string,
    signature: string,
    timestamp: string,
  ): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Signature": signature,
          "X-Webhook-Timestamp": timestamp,
        },
        body: payload,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(
          `Webhook delivery failed: HTTP ${response.status} ${response.statusText}`,
        );
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error(
          `Webhook delivery timed out after ${REQUEST_TIMEOUT_MS}ms`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
