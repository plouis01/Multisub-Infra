import { Router } from "express";
import type { Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { IssueCardSchema } from "../types/index.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import type { LithicClient } from "../integrations/lithic.js";
import { setCardMapping } from "../lib/redis.js";
import type { Redis } from "ioredis";
import type { CardMapping } from "../types/index.js";

// ============ Types ============

interface CardsDeps {
  prisma: PrismaClient;
  lithicClient: LithicClient;
  redis: Redis;
}

// ============ Update Card Schema ============

const UpdateCardSchema = z.object({
  action: z.enum(["freeze", "unfreeze", "cancel"]).optional(),
  dailyLimit: z.number().int().positive().max(100_000_00).optional(),
  monthlyLimit: z.number().int().positive().max(1_000_000_00).optional(),
  mccBlacklist: z.array(z.string().length(4)).optional(),
});

// ============ Cards Router ============

export function createCardsRouter(deps: CardsDeps): Router {
  const router = Router();
  const { prisma, lithicClient, redis } = deps;

  // ---------- POST /v1/users/:userId/cards — Issue card ----------

  router.post("/v1/users/:userId/cards", async (req, res: Response) => {
    try {
      const authReq = req as unknown as AuthenticatedRequest;
      const tenantId = authReq.tenantId;
      const { userId } = req.params;

      // Validate request body
      const parsed = IssueCardSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Validation failed",
          details: parsed.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        });
        return;
      }

      const { type, dailyLimit, monthlyLimit, mccBlacklist } = parsed.data;

      // Verify user belongs to this tenant
      const user = await prisma.user.findFirst({
        where: { id: userId, tenantId },
        select: { id: true, eoaAddress: true, m2SafeAddress: true },
      });

      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      // Issue card via Lithic
      const lithicCard = await lithicClient.createCard({
        type,
        spendLimit: dailyLimit,
        memo: `MultiSubs card for user ${userId}`,
      });

      // Create sub-account in database
      const subAccount = await prisma.subAccount.create({
        data: {
          tenantId,
          userId,
          lithicCardToken: lithicCard.token,
          lithicCardId: lithicCard.token,
          eoaAddress: user.eoaAddress,
          type,
          dailyLimit: BigInt(dailyLimit),
          monthlyLimit: BigInt(monthlyLimit),
          mccBlacklist: mccBlacklist ?? [],
          status: "active",
        },
        select: {
          id: true,
          type: true,
          lithicCardToken: true,
          dailyLimit: true,
          monthlyLimit: true,
          mccBlacklist: true,
          status: true,
          createdAt: true,
        },
      });

      // Cache card mapping in Redis
      if (user.eoaAddress && user.m2SafeAddress) {
        const mapping: CardMapping = {
          subAccountId: subAccount.id,
          tenantId,
          eoaAddress: user.eoaAddress,
          m2SafeAddress: user.m2SafeAddress,
          status: "active",
        };
        await setCardMapping(redis, lithicCard.token, mapping);
      }

      res.status(201).json({
        ...subAccount,
        dailyLimit: subAccount.dailyLimit.toString(),
        monthlyLimit: subAccount.monthlyLimit.toString(),
        lithicCard: {
          token: lithicCard.token,
          type: lithicCard.type,
          state: lithicCard.state,
          lastFour: lithicCard.last_four,
        },
      });
    } catch (error) {
      console.error("[Cards] POST /v1/users/:userId/cards error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ---------- GET /v1/users/:userId/cards — List user's cards ----------

  router.get("/v1/users/:userId/cards", async (req, res: Response) => {
    try {
      const authReq = req as unknown as AuthenticatedRequest;
      const tenantId = authReq.tenantId;
      const { userId } = req.params;

      // Verify user belongs to this tenant
      const user = await prisma.user.findFirst({
        where: { id: userId, tenantId },
        select: { id: true },
      });

      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      const subAccounts = await prisma.subAccount.findMany({
        where: { userId, tenantId },
        select: {
          id: true,
          type: true,
          lithicCardToken: true,
          dailyLimit: true,
          monthlyLimit: true,
          mccBlacklist: true,
          status: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { createdAt: "desc" },
      });

      const cards = subAccounts.map(
        (sa: { dailyLimit: bigint; monthlyLimit: bigint }) => ({
          ...sa,
          dailyLimit: sa.dailyLimit.toString(),
          monthlyLimit: sa.monthlyLimit.toString(),
        }),
      );

      res.json({ cards });
    } catch (error) {
      console.error("[Cards] GET /v1/users/:userId/cards error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ---------- PATCH /v1/cards/:cardId — Update card ----------

  router.patch("/v1/cards/:cardId", async (req, res: Response) => {
    try {
      const authReq = req as unknown as AuthenticatedRequest;
      const tenantId = authReq.tenantId;
      const { cardId } = req.params;

      // Validate request body
      const parsed = UpdateCardSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Validation failed",
          details: parsed.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        });
        return;
      }

      const { action, dailyLimit, monthlyLimit, mccBlacklist } = parsed.data;

      // Find sub-account and verify tenant ownership
      const subAccount = await prisma.subAccount.findFirst({
        where: { id: cardId, tenantId },
        include: {
          user: {
            select: { eoaAddress: true, m2SafeAddress: true },
          },
        },
      });

      if (!subAccount) {
        res.status(404).json({ error: "Card not found" });
        return;
      }

      // Build update payload
      const updateData: Record<string, unknown> = {};
      let lithicState: "OPEN" | "PAUSED" | "CLOSED" | undefined;

      if (action === "freeze") {
        updateData.status = "frozen";
        lithicState = "PAUSED";
      } else if (action === "unfreeze") {
        updateData.status = "active";
        lithicState = "OPEN";
      } else if (action === "cancel") {
        updateData.status = "cancelled";
        lithicState = "CLOSED";
      }

      if (dailyLimit !== undefined) {
        updateData.dailyLimit = BigInt(dailyLimit);
      }
      if (monthlyLimit !== undefined) {
        updateData.monthlyLimit = BigInt(monthlyLimit);
      }
      if (mccBlacklist !== undefined) {
        updateData.mccBlacklist = mccBlacklist;
      }

      // Update Lithic card state if applicable
      if (
        subAccount.lithicCardToken &&
        (lithicState || dailyLimit !== undefined)
      ) {
        await lithicClient.updateCard(subAccount.lithicCardToken, {
          state: lithicState,
          spendLimit: dailyLimit,
        });
      }

      // Update database
      const updated = await prisma.subAccount.update({
        where: { id: cardId },
        data: updateData,
        select: {
          id: true,
          type: true,
          lithicCardToken: true,
          dailyLimit: true,
          monthlyLimit: true,
          mccBlacklist: true,
          status: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      // Update Redis card mapping
      if (
        subAccount.lithicCardToken &&
        subAccount.user.eoaAddress &&
        subAccount.user.m2SafeAddress
      ) {
        const mapping: CardMapping = {
          subAccountId: subAccount.id,
          tenantId,
          eoaAddress: subAccount.user.eoaAddress,
          m2SafeAddress: subAccount.user.m2SafeAddress,
          status: updated.status as CardMapping["status"],
        };
        await setCardMapping(redis, subAccount.lithicCardToken, mapping);
      }

      res.json({
        ...updated,
        dailyLimit: updated.dailyLimit.toString(),
        monthlyLimit: updated.monthlyLimit.toString(),
      });
    } catch (error) {
      console.error("[Cards] PATCH /v1/cards/:cardId error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
