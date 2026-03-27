import { Router } from "express";
import type { Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { PaginationSchema } from "../types/index.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";

// ============ Types ============

interface YieldDeps {
  prisma: PrismaClient;
}

// ============ Yield Router ============

export function createYieldRouter(deps: YieldDeps): Router {
  const router = Router();
  const { prisma } = deps;

  // ---------- GET /v1/yield/summary — Get tenant yield summary ----------

  router.get("/v1/yield/summary", async (req, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const tenantId = authReq.tenantId;

      // Get the latest yield snapshot for this tenant
      const latestSnapshot = await prisma.yieldLedger.findFirst({
        where: { tenantId },
        orderBy: { snapshotDate: "desc" },
        select: {
          totalDeposited: true,
          totalShares: true,
          totalYield: true,
          apyBps: true,
          snapshotDate: true,
        },
      });

      if (!latestSnapshot) {
        res.json({
          totalDeposited: "0",
          totalShares: "0",
          unrealizedYield: "0",
          apyBps: 0,
          snapshotDate: null,
        });
        return;
      }

      res.json({
        totalDeposited: latestSnapshot.totalDeposited,
        totalShares: latestSnapshot.totalShares,
        unrealizedYield: latestSnapshot.totalYield,
        apyBps: latestSnapshot.apyBps,
        snapshotDate: latestSnapshot.snapshotDate,
      });
    } catch (error) {
      console.error("[Yield] GET /v1/yield/summary error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ---------- GET /v1/yield/snapshots — List yield snapshots ----------

  router.get("/v1/yield/snapshots", async (req, res: Response) => {
    try {
      const authReq = req as unknown as AuthenticatedRequest;
      const tenantId = authReq.tenantId;

      // Validate pagination params
      const parsed = PaginationSchema.safeParse(req.query);
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

      const { limit, offset } = parsed.data;

      const [snapshots, total] = await Promise.all([
        prisma.yieldLedger.findMany({
          where: { tenantId },
          select: {
            id: true,
            snapshotDate: true,
            totalDeposited: true,
            totalShares: true,
            totalYield: true,
            apyBps: true,
            createdAt: true,
          },
          orderBy: { snapshotDate: "desc" },
          take: limit,
          skip: offset,
        }),
        prisma.yieldLedger.count({ where: { tenantId } }),
      ]);

      res.json({
        items: snapshots,
        total,
        limit,
        offset,
      });
    } catch (error) {
      console.error("[Yield] GET /v1/yield/snapshots error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
