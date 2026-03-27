import { Router } from "express";
import type { Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";
import type { AuthorizationEngine } from "../services/authorization-engine.js";
import type { SettlementService } from "../services/settlement-service.js";
import type { LithicClient } from "../integrations/lithic.js";
import type { WebhookDispatcher } from "../services/webhook-dispatcher.js";
import { getCardMapping } from "../lib/redis.js";
import type { Redis } from "ioredis";
import type { LithicASAResponse, WebhookEventType } from "../types/index.js";

// ============ Types ============

interface WebhooksDeps {
  authorizationEngine: AuthorizationEngine;
  settlementService: SettlementService | null;
  lithicClient: LithicClient;
  webhookDispatcher: WebhookDispatcher | null;
  prisma: PrismaClient;
  redis: Redis;
  platformIssuerSafeAddress: string;
}

// ============ Webhooks Router ============

/**
 * Webhook receiver routes.
 *
 * These routes do NOT use the standard API key auth middleware.
 * Instead, the Lithic ASA webhook verifies the request via HMAC signature.
 */
export function createWebhooksRouter(deps: WebhooksDeps): Router {
  const router = Router();
  const {
    authorizationEngine,
    settlementService,
    lithicClient,
    webhookDispatcher,
    prisma,
    redis,
    platformIssuerSafeAddress,
  } = deps;

  // ---------- POST /webhooks/lithic/asa — Lithic ASA webhook ----------

  router.post("/webhooks/lithic/asa", async (req: Request, res: Response) => {
    try {
      // Verify HMAC signature
      const signature = req.headers["x-lithic-signature"] as string | undefined;
      const rawBody = (req as any).rawBody as string | undefined;
      if (!rawBody) {
        res.status(400).json({ error: "Missing request body" });
        return;
      }

      if (!signature) {
        res.status(401).json({ error: "Missing X-Lithic-Signature header" });
        return;
      }

      const isValid = lithicClient.verifyWebhookSignature(rawBody, signature);
      if (!isValid) {
        console.warn("[Webhooks] Invalid Lithic webhook signature");
        res.status(401).json({ error: "Invalid webhook signature" });
        return;
      }

      // Parse the ASA event
      const body =
        typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      const event = lithicClient.parseASAEvent(body);

      // Replay protection: check if this token was already processed
      const dedupeKey = `webhook:processed:${event.token}`;
      const alreadyProcessed = await redis.get(dedupeKey);
      if (alreadyProcessed) {
        console.warn(
          `[Webhooks] Duplicate webhook token ${event.token} — skipping`,
        );
        res.json({ result: "APPROVED" } as LithicASAResponse); // Return last known result
        return;
      }

      // Run authorization engine
      const result = await authorizationEngine.authorize(event);

      // Mark as processed with 5-minute TTL
      await redis.set(
        dedupeKey,
        result.approved ? "APPROVED" : "DECLINED",
        "EX",
        300,
      );

      // Build the ASA response
      const asaResponse: LithicASAResponse = {
        result: result.approved ? "APPROVED" : "DECLINED",
      };

      // Lookup card mapping for tenant context
      const cardMapping = await getCardMapping(redis, event.card_token);

      // Create Transaction record and enqueue settlement (fire-and-forget)
      if (cardMapping) {
        const txRecord = prisma.transaction
          .create({
            data: {
              tenantId: cardMapping.tenantId,
              userId: cardMapping.subAccountId,
              lithicTxToken: event.token,
              type: "authorization",
              amount: BigInt(event.amount),
              currency: "USD",
              merchantName: event.merchant.descriptor,
              merchantMcc: event.merchant.mcc,
              status: result.approved ? "approved" : "declined",
            },
          })
          .catch((err: unknown) => {
            console.error(
              "[Webhooks] Failed to create transaction record:",
              err,
            );
          });

        // Enqueue settlement job on approval
        if (result.approved && settlementService && cardMapping.m2SafeAddress) {
          txRecord.then(() => {
            settlementService
              .enqueue({
                lithicTxToken: event.token,
                m2SafeAddress: cardMapping.m2SafeAddress,
                issuerSafeAddress: platformIssuerSafeAddress,
                amount: event.amount.toString(),
                tenantId: cardMapping.tenantId,
                attempt: 1,
                createdAt: Date.now(),
              })
              .catch((err: unknown) => {
                console.error(
                  "[Webhooks] Failed to enqueue settlement job:",
                  err,
                );
              });
          });
        }
      }

      // Dispatch webhook event to tenant (fire and forget)
      if (webhookDispatcher) {
        const eventType: WebhookEventType = result.approved
          ? "card.authorization.approved"
          : "card.authorization.declined";

        webhookDispatcher
          .dispatchForCard(event.card_token, {
            type: eventType,
            data: {
              lithicTxToken: event.token,
              cardToken: event.card_token,
              amount: event.amount,
              merchant: event.merchant,
              approved: result.approved,
              reason: result.reason ?? null,
              balanceAfter: result.balanceAfter ?? null,
            },
          })
          .catch((err) => {
            console.error("[Webhooks] Failed to dispatch tenant webhook:", err);
          });
      }

      res.json(asaResponse);
    } catch (error) {
      console.error("[Webhooks] POST /webhooks/lithic/asa error:", error);

      // On any unhandled error, decline for safety
      const safeResponse: LithicASAResponse = { result: "DECLINED" };
      res.json(safeResponse);
    }
  });

  return router;
}
