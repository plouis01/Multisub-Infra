import { Router } from "express";
import type { Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { SumsubClient } from "../integrations/kyc.js";
import type { KycWebhookEvent } from "../integrations/kyc.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";

// ============ Types ============

interface KycDeps {
  prisma: PrismaClient;
  sumsubClient: SumsubClient;
  sumsubLevelName: string;
}

const idSchema = z.string().min(1).max(255);

// ============ KYC Router (Authenticated) ============

export function createKycRouter(deps: KycDeps): Router {
  const router = Router();
  const { prisma, sumsubClient, sumsubLevelName } = deps;

  // ---------- POST /v1/users/:userId/kyc/session — Create KYC session ----------

  router.post(
    "/v1/users/:userId/kyc/session",
    async (req: Request, res: Response) => {
      try {
        const authReq = req as AuthenticatedRequest;
        const tenantId = authReq.tenantId;

        const parseResult = idSchema.safeParse(req.params.userId);
        if (!parseResult.success) {
          res.status(400).json({ error: "Invalid user ID format" });
          return;
        }

        const userId = parseResult.data;

        // Verify user belongs to this tenant
        const user = await prisma.user.findFirst({
          where: { id: userId, tenantId },
          select: { id: true, externalId: true, email: true, kycStatus: true },
        });

        if (!user) {
          res.status(404).json({ error: "User not found" });
          return;
        }

        // Create Sumsub applicant if not already done
        const applicant = await sumsubClient.createApplicant({
          externalUserId: user.externalId,
          email: user.email ?? undefined,
          levelName: sumsubLevelName,
        });

        // Create access token for frontend SDK
        const accessToken = await sumsubClient.createAccessToken(
          user.externalId,
          sumsubLevelName,
        );

        // Update user KYC status to pending if currently in initial state
        if (user.kycStatus === "pending") {
          await prisma.user.update({
            where: { id: userId },
            data: { kycStatus: "pending" },
          });
        }

        res.status(200).json({
          applicantId: applicant.id,
          token: accessToken.token,
          userId: accessToken.userId,
        });
      } catch (error) {
        console.error("[KYC] POST /v1/users/:userId/kyc/session error:", error);
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // ---------- GET /v1/users/:userId/kyc/status — Get KYC status ----------

  router.get(
    "/v1/users/:userId/kyc/status",
    async (req: Request, res: Response) => {
      try {
        const authReq = req as AuthenticatedRequest;
        const tenantId = authReq.tenantId;

        const parseResult = idSchema.safeParse(req.params.userId);
        if (!parseResult.success) {
          res.status(400).json({ error: "Invalid user ID format" });
          return;
        }

        const userId = parseResult.data;

        // Verify user belongs to this tenant
        const user = await prisma.user.findFirst({
          where: { id: userId, tenantId },
          select: { id: true, externalId: true, kycStatus: true },
        });

        if (!user) {
          res.status(404).json({ error: "User not found" });
          return;
        }

        res.json({
          userId: user.id,
          kycStatus: user.kycStatus,
        });
      } catch (error) {
        console.error("[KYC] GET /v1/users/:userId/kyc/status error:", error);
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  return router;
}

// ============ KYC Webhook Router (No Auth) ============

interface KycWebhookDeps {
  prisma: PrismaClient;
  sumsubClient: SumsubClient;
}

export function createKycWebhookRouter(deps: KycWebhookDeps): Router {
  const router = Router();
  const { prisma, sumsubClient } = deps;

  // ---------- POST /webhooks/sumsub — Sumsub webhook handler ----------

  router.post("/webhooks/sumsub", async (req: Request, res: Response) => {
    try {
      // Get raw body for HMAC verification
      const rawBody = (req as any).rawBody as string | undefined;
      if (!rawBody) {
        res.status(400).json({ error: "Missing request body" });
        return;
      }

      // Verify webhook signature
      const signature = req.headers["x-payload-digest"] as string | undefined;
      if (!signature) {
        res.status(401).json({ error: "Missing webhook signature header" });
        return;
      }

      const isValid = sumsubClient.verifyWebhookSignature(rawBody, signature);
      if (!isValid) {
        console.warn("[KYC] Invalid Sumsub webhook signature");
        res.status(401).json({ error: "Invalid webhook signature" });
        return;
      }

      // Parse the webhook event
      const event: KycWebhookEvent =
        typeof req.body === "string" ? JSON.parse(req.body) : req.body;

      if (!event.externalUserId || !event.type) {
        res.status(400).json({ error: "Invalid webhook payload" });
        return;
      }

      // Look up the user by externalId (search across all tenants)
      const user = await prisma.user.findFirst({
        where: { externalId: event.externalUserId },
        select: { id: true, tenantId: true, kycStatus: true },
      });

      if (!user) {
        // User not found — acknowledge the webhook but do nothing
        console.warn(
          `[KYC] Webhook for unknown externalUserId: ${event.externalUserId}`,
        );
        res.status(200).json({ ok: true });
        return;
      }

      // Determine new KYC status based on review result
      let newKycStatus: string | null = null;

      if (event.type === "applicantReviewed" && event.reviewResult) {
        switch (event.reviewResult.reviewAnswer) {
          case "GREEN":
            newKycStatus = "approved";
            break;
          case "RED":
            newKycStatus = "rejected";
            break;
          case "YELLOW":
            newKycStatus = "pending";
            break;
        }
      } else if (event.type === "applicantPending") {
        newKycStatus = "pending";
      } else if (event.type === "applicantOnHold") {
        newKycStatus = "pending";
      }

      // Update user KYC status if changed
      if (newKycStatus && newKycStatus !== user.kycStatus) {
        await prisma.user.update({
          where: { id: user.id },
          data: { kycStatus: newKycStatus },
        });
      }

      // Create audit log entry
      await prisma.auditLog.create({
        data: {
          tenantId: user.tenantId,
          action: `kyc_${event.type}`,
          userId: user.id,
          details: {
            applicantId: event.applicantId,
            externalUserId: event.externalUserId,
            type: event.type,
            reviewResult: event.reviewResult ?? null,
            previousStatus: user.kycStatus,
            newStatus: newKycStatus ?? user.kycStatus,
          },
        },
      });

      res.status(200).json({ ok: true });
    } catch (error) {
      console.error("[KYC] POST /webhooks/sumsub error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
