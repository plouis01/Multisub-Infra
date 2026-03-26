import { Router } from "express";
import type { Request, Response } from "express";
import type { AuthorizationEngine } from "../services/authorization-engine.js";
import type { LithicClient } from "../integrations/lithic.js";
import type { WebhookDispatcher } from "../services/webhook-dispatcher.js";
import type { LithicASAResponse, WebhookEventType } from "../types/index.js";

// ============ Types ============

interface WebhooksDeps {
  authorizationEngine: AuthorizationEngine;
  lithicClient: LithicClient;
  webhookDispatcher: WebhookDispatcher | null;
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
  const { authorizationEngine, lithicClient, webhookDispatcher } = deps;

  // ---------- POST /webhooks/lithic/asa — Lithic ASA webhook ----------

  router.post("/webhooks/lithic/asa", async (req: Request, res: Response) => {
    try {
      // Verify HMAC signature
      const signature = req.headers["x-lithic-signature"] as string | undefined;
      const rawBody =
        typeof req.body === "string" ? req.body : JSON.stringify(req.body);

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

      // Run authorization engine
      const result = await authorizationEngine.authorize(event);

      // Build the ASA response
      const asaResponse: LithicASAResponse = {
        result: result.approved ? "APPROVED" : "DECLINED",
      };

      // Dispatch webhook event to tenant (fire and forget)
      if (webhookDispatcher) {
        const eventType: WebhookEventType = result.approved
          ? "card.authorization.approved"
          : "card.authorization.declined";

        // We need the tenantId from the card mapping — the authorization engine
        // already looked this up, but we do a lightweight lookup here to get it
        // for webhook dispatch. In a production system you'd pass this through
        // the authorization result.
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
