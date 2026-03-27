import { Router } from "express";
import type { Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { PaginationSchema } from "../types/index.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import type { Config } from "../config/index.js";

// ============ Types ============

interface AdminDeps {
  prisma: PrismaClient;
  config: Config;
  adminTenantId: string;
}

// ============ Admin Router ============

export function createAdminRouter(deps: AdminDeps): Router {
  const router = Router();
  const { prisma, config, adminTenantId } = deps;

  /**
   * Middleware: reject non-admin callers with 403.
   */
  function requireAdmin(req: AuthenticatedRequest, res: Response): boolean {
    if (req.tenantId !== adminTenantId) {
      res.status(403).json({ error: "Forbidden: admin access required" });
      return false;
    }
    return true;
  }

  // ---------- GET /v1/admin/dashboard — Multi-tenant overview ----------

  router.get("/v1/admin/dashboard", async (req, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest;
      if (!requireAdmin(authReq, res)) return;

      const now = new Date();
      const startOfDay = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
      );

      const [
        tenantCounts,
        totalUsers,
        totalSubAccounts,
        totalTxToday,
        volumeToday,
      ] = await Promise.all([
        // Tenant status breakdown
        prisma.tenant.groupBy({
          by: ["status"],
          _count: { id: true },
        }),
        // Total users across all tenants
        prisma.user.count(),
        // Total active sub-accounts (cards)
        prisma.subAccount.count({
          where: { status: "active" },
        }),
        // Total transactions today
        prisma.transaction.count({
          where: { createdAt: { gte: startOfDay } },
        }),
        // Sum of settled amounts today
        prisma.transaction.aggregate({
          where: {
            status: "settled",
            createdAt: { gte: startOfDay },
          },
          _sum: { amount: true },
        }),
      ]);

      // Build tenant status counts
      const statusCounts: Record<string, number> = {
        active: 0,
        suspended: 0,
        disabled: 0,
      };
      let totalTenants = 0;
      for (const row of tenantCounts) {
        statusCounts[row.status] = row._count.id;
        totalTenants += row._count.id;
      }

      res.json({
        totalTenants,
        tenantsByStatus: statusCounts,
        totalUsers,
        totalSubAccounts,
        totalTransactionsToday: totalTxToday,
        totalVolumeToday: (volumeToday._sum.amount ?? 0n).toString(),
      });
    } catch (error) {
      console.error("[Admin] GET /v1/admin/dashboard error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ---------- GET /v1/admin/treasury — M1 Treasury health ----------

  router.get("/v1/admin/treasury", async (req, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest;
      if (!requireAdmin(authReq, res)) return;

      // Get the latest sweep and yield snapshot timestamps
      const [lastSweepEntry, lastYieldSnapshot] = await Promise.all([
        prisma.balanceLedger.findFirst({
          where: { type: "sweep" },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        }),
        prisma.yieldLedger.findFirst({
          orderBy: { snapshotDate: "desc" },
          select: { snapshotDate: true },
        }),
      ]);

      res.json({
        addresses: {
          m1Treasury: config.m1TreasuryAddress || null,
          platformIssuerSafe: config.platformIssuerSafeAddress || null,
          usdc: config.usdcAddress || null,
          morphoVault: config.morphoVaultAddress || null,
          treasuryVault: config.treasuryVaultAddress || null,
        },
        lastSweepTimestamp: lastSweepEntry?.createdAt?.toISOString() ?? null,
        lastYieldSnapshotTimestamp:
          lastYieldSnapshot?.snapshotDate?.toISOString() ?? null,
      });
    } catch (error) {
      console.error("[Admin] GET /v1/admin/treasury error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ---------- GET /v1/admin/settlement-queue — Settlement queue status ----------

  router.get("/v1/admin/settlement-queue", async (req, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest;
      if (!requireAdmin(authReq, res)) return;

      const [pendingCount, failedCount, recentFailures, avgSettlement] =
        await Promise.all([
          // Pending settlements
          prisma.transaction.count({
            where: { type: "settlement", status: "pending" },
          }),
          // Failed settlements
          prisma.transaction.count({
            where: { type: "settlement", status: "failed" },
          }),
          // Recent failures (last 10)
          prisma.transaction.findMany({
            where: { type: "settlement", status: "failed" },
            orderBy: { updatedAt: "desc" },
            take: 10,
            select: {
              id: true,
              lithicTxToken: true,
              amount: true,
              errorMessage: true,
              retryCount: true,
              createdAt: true,
              updatedAt: true,
            },
          }),
          // Average settlement time: difference between createdAt and updatedAt
          // for settled transactions (updatedAt is when they were settled)
          prisma.$queryRaw<[{ avg_ms: number | null }]>`
            SELECT AVG(EXTRACT(EPOCH FROM ("updatedAt" - "createdAt")) * 1000)::float AS avg_ms
            FROM "Transaction"
            WHERE "type" = 'settlement' AND "status" = 'settled'
          `,
        ]);

      const avgSettlementTimeMs = avgSettlement[0]?.avg_ms ?? null;

      res.json({
        pendingCount,
        failedCount,
        averageSettlementTimeMs: avgSettlementTimeMs
          ? Math.round(avgSettlementTimeMs)
          : null,
        recentFailures: recentFailures.map((f) => ({
          ...f,
          amount: f.amount.toString(),
        })),
      });
    } catch (error) {
      console.error("[Admin] GET /v1/admin/settlement-queue error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ---------- GET /v1/admin/tenants/metrics — Per-tenant metrics (paginated) ----------

  router.get("/v1/admin/tenants/metrics", async (req, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest;
      if (!requireAdmin(authReq, res)) return;

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

      // Get all tenants with aggregated metrics
      // Use raw query for efficient aggregation with volume-based sorting
      const metrics = await prisma.$queryRaw<
        Array<{
          tenantId: string;
          tenantName: string;
          tenantStatus: string;
          userCount: bigint;
          cardCount: bigint;
          txCount: bigint;
          volume: bigint;
        }>
      >`
        SELECT
          t."id" AS "tenantId",
          t."name" AS "tenantName",
          t."status" AS "tenantStatus",
          COALESCE((SELECT COUNT(*) FROM "User" u WHERE u."tenantId" = t."id"), 0) AS "userCount",
          COALESCE((SELECT COUNT(*) FROM "SubAccount" sa WHERE sa."tenantId" = t."id"), 0) AS "cardCount",
          COALESCE((SELECT COUNT(*) FROM "Transaction" tx WHERE tx."tenantId" = t."id"), 0) AS "txCount",
          COALESCE((SELECT SUM(tx."amount") FROM "Transaction" tx WHERE tx."tenantId" = t."id" AND tx."status" = 'settled'), 0) AS "volume"
        FROM "Tenant" t
        ORDER BY volume DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `;

      const totalTenants = await prisma.tenant.count();

      // Get yield accrued per tenant (totalYield is stored as a string,
      // so we cast to numeric in SQL to aggregate)
      const yieldByTenant = await prisma.$queryRaw<
        Array<{ tenantId: string; yieldTotal: string }>
      >`
        SELECT "tenantId", COALESCE(SUM("totalYield"::numeric), 0)::text AS "yieldTotal"
        FROM "YieldLedger"
        GROUP BY "tenantId"
      `;

      const yieldMap = new Map<string, string>();
      for (const row of yieldByTenant) {
        yieldMap.set(row.tenantId, row.yieldTotal);
      }

      const items = metrics.map((m) => ({
        tenantId: m.tenantId,
        tenantName: m.tenantName,
        tenantStatus: m.tenantStatus,
        userCount: Number(m.userCount),
        cardCount: Number(m.cardCount),
        txCount: Number(m.txCount),
        volume: m.volume.toString(),
        yieldAccrued: yieldMap.get(m.tenantId) ?? "0",
      }));

      res.json({
        items,
        total: totalTenants,
        limit,
        offset,
      });
    } catch (error) {
      console.error("[Admin] GET /v1/admin/tenants/metrics error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
