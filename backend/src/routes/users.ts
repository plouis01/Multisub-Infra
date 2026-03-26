import { Router } from "express";
import type { Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { CreateUserSchema } from "../types/index.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";

// ============ Types ============

interface UsersDeps {
  prisma: PrismaClient;
}

// ============ Users Router ============

export function createUsersRouter(deps: UsersDeps): Router {
  const router = Router();
  const { prisma } = deps;

  // ---------- POST /v1/users — Create user ----------

  router.post("/v1/users", async (req, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const tenantId = authReq.tenantId;

      // Validate request body
      const parsed = CreateUserSchema.safeParse(req.body);
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

      const { externalId, email, kycStatus } = parsed.data;

      // Check for duplicate externalId within this tenant
      const existing = await prisma.user.findUnique({
        where: { tenantId_externalId: { tenantId, externalId } },
      });

      if (existing) {
        res.status(409).json({
          error: "User already exists",
          userId: existing.id,
        });
        return;
      }

      // Create user
      const user = await prisma.user.create({
        data: {
          tenantId,
          externalId,
          email: email ?? null,
          kycStatus,
        },
        select: {
          id: true,
          externalId: true,
          email: true,
          kycStatus: true,
          m2SafeAddress: true,
          eoaAddress: true,
          status: true,
          createdAt: true,
        },
      });

      res.status(201).json(user);
    } catch (error) {
      console.error("[Users] POST /v1/users error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ---------- GET /v1/users/:id — Get user details ----------

  router.get("/v1/users/:id", async (req, res: Response) => {
    try {
      const authReq = req as unknown as AuthenticatedRequest;
      const tenantId = authReq.tenantId;
      const { id } = req.params;

      const user = await prisma.user.findFirst({
        where: { id, tenantId },
        select: {
          id: true,
          externalId: true,
          email: true,
          kycStatus: true,
          m2SafeAddress: true,
          eoaAddress: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          subAccounts: {
            select: {
              id: true,
              type: true,
              lithicCardToken: true,
              dailyLimit: true,
              monthlyLimit: true,
              status: true,
              createdAt: true,
            },
          },
        },
      });

      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      // Convert BigInt fields to strings for JSON serialization
      const response = {
        ...user,
        subAccounts: user.subAccounts.map((sa) => ({
          ...sa,
          dailyLimit: sa.dailyLimit.toString(),
          monthlyLimit: sa.monthlyLimit.toString(),
        })),
      };

      res.json(response);
    } catch (error) {
      console.error("[Users] GET /v1/users/:id error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ---------- GET /v1/users/:id/balance — Get user balance ----------

  router.get("/v1/users/:id/balance", async (req, res: Response) => {
    try {
      const authReq = req as unknown as AuthenticatedRequest;
      const tenantId = authReq.tenantId;
      const { id } = req.params;

      // Verify user belongs to this tenant
      const user = await prisma.user.findFirst({
        where: { id, tenantId },
        select: { id: true },
      });

      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }

      // Compute balance from ledger entries
      const ledgerEntries = await prisma.balanceLedger.findMany({
        where: { userId: id, token: "USDC" },
        select: { type: true, amount: true },
      });

      const creditTypes = new Set(["deposit", "refund", "yield"]);
      let netBalance = 0n;
      for (const entry of ledgerEntries) {
        const entryAmount = BigInt(entry.amount);
        if (creditTypes.has(entry.type)) {
          netBalance += entryAmount;
        } else {
          netBalance -= entryAmount;
        }
      }
      if (netBalance < 0n) {
        netBalance = 0n;
      }

      // Get recent transactions for spend summary
      const now = new Date();
      const startOfDay = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
      );
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

      const [dailyAgg, monthlyAgg] = await Promise.all([
        prisma.transaction.aggregate({
          where: {
            userId: id,
            type: "authorization",
            status: { in: ["approved", "settled"] },
            createdAt: { gte: startOfDay },
          },
          _sum: { amount: true },
        }),
        prisma.transaction.aggregate({
          where: {
            userId: id,
            type: "authorization",
            status: { in: ["approved", "settled"] },
            createdAt: { gte: startOfMonth },
          },
          _sum: { amount: true },
        }),
      ]);

      res.json({
        userId: id,
        token: "USDC",
        balance: netBalance.toString(),
        dailySpent: (dailyAgg._sum.amount ?? 0n).toString(),
        monthlySpent: (monthlyAgg._sum.amount ?? 0n).toString(),
      });
    } catch (error) {
      console.error("[Users] GET /v1/users/:id/balance error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
