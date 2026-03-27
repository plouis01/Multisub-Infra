import { Router } from "express";
import type { Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { TransactionQuerySchema } from "../types/index.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";

// ============ Types ============

interface TransactionsDeps {
  prisma: PrismaClient;
}

// ============ Transactions Router ============

export function createTransactionsRouter(deps: TransactionsDeps): Router {
  const router = Router();
  const { prisma } = deps;

  // ---------- GET /v1/transactions — List transactions ----------

  router.get("/v1/transactions", async (req, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const tenantId = authReq.tenantId;

      // Validate query params
      const parsed = TransactionQuerySchema.safeParse(req.query);
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

      const { limit, offset, status, type } = parsed.data;

      // Build where clause scoped to tenant
      const where: Record<string, unknown> = { tenantId };
      if (status) where.status = status;
      if (type) where.type = type;

      const [transactions, total] = await Promise.all([
        prisma.transaction.findMany({
          where,
          select: {
            id: true,
            userId: true,
            subAccountId: true,
            lithicTxToken: true,
            type: true,
            amount: true,
            currency: true,
            merchantName: true,
            merchantMcc: true,
            status: true,
            onChainTxHash: true,
            createdAt: true,
            updatedAt: true,
          },
          orderBy: { createdAt: "desc" },
          take: limit,
          skip: offset,
        }),
        prisma.transaction.count({ where }),
      ]);

      // Serialize BigInt fields to strings
      const items = transactions.map((tx: { amount: bigint }) => ({
        ...tx,
        amount: tx.amount.toString(),
      }));

      res.json({
        items,
        total,
        limit,
        offset,
      });
    } catch (error) {
      console.error("[Transactions] GET /v1/transactions error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ---------- GET /v1/transactions/:id — Get transaction details ----------

  router.get("/v1/transactions/:id", async (req, res: Response) => {
    try {
      const authReq = req as unknown as AuthenticatedRequest;
      const tenantId = authReq.tenantId;
      const { id } = req.params;

      const transaction = await prisma.transaction.findFirst({
        where: { id, tenantId },
        select: {
          id: true,
          userId: true,
          subAccountId: true,
          lithicTxToken: true,
          type: true,
          amount: true,
          currency: true,
          merchantName: true,
          merchantMcc: true,
          status: true,
          onChainTxHash: true,
          settlementNonce: true,
          errorMessage: true,
          retryCount: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      if (!transaction) {
        res.status(404).json({ error: "Transaction not found" });
        return;
      }

      res.json({
        ...transaction,
        amount: transaction.amount.toString(),
        settlementNonce: transaction.settlementNonce?.toString() ?? null,
      });
    } catch (error) {
      console.error("[Transactions] GET /v1/transactions/:id error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
