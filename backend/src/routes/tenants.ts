import { randomBytes, createHash } from "node:crypto";
import { Router } from "express";
import type { Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { CreateTenantSchema, UpdateTenantSchema } from "../types/index.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";

// ============ Types ============

interface TenantsDeps {
  prisma: PrismaClient;
  adminTenantId: string;
}

// ============ Helpers ============

/**
 * Generate a random API key prefixed with `msk_` (MultiSubs Key).
 * Returns both the raw key (shown once) and its SHA-256 hash (stored).
 */
function generateApiKey(): { raw: string; hash: string } {
  const raw = `msk_${randomBytes(32).toString("hex")}`;
  const hash = createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

// ============ Tenants Router ============

export function createTenantsRouter(deps: TenantsDeps): Router {
  const router = Router();
  const { prisma, adminTenantId } = deps;

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

  // ---------- POST /v1/tenants — Create tenant ----------

  router.post("/v1/tenants", async (req, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest;
      if (!requireAdmin(authReq, res)) return;

      // Validate request body
      const parsed = CreateTenantSchema.safeParse(req.body);
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

      const { name, custodyModel, webhookUrl, rateLimit } = parsed.data;
      const { raw, hash } = generateApiKey();

      const tenant = await prisma.tenant.create({
        data: {
          name,
          custodyModel,
          apiKeyHash: hash,
          webhookUrl: webhookUrl ?? null,
          rateLimit,
          status: "active",
        },
        select: {
          id: true,
          name: true,
          custodyModel: true,
          webhookUrl: true,
          rateLimit: true,
          status: true,
          createdAt: true,
        },
      });

      // Return the unhashed API key exactly once
      res.status(201).json({
        ...tenant,
        apiKey: raw,
      });
    } catch (error) {
      console.error("[Tenants] POST /v1/tenants error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ---------- GET /v1/tenants/:id — Get tenant details ----------

  router.get("/v1/tenants/:id", async (req, res: Response) => {
    try {
      const authReq = req as unknown as AuthenticatedRequest;
      if (!requireAdmin(authReq, res)) return;

      const { id } = req.params;

      const tenant = await prisma.tenant.findUnique({
        where: { id },
        select: {
          id: true,
          name: true,
          custodyModel: true,
          webhookUrl: true,
          rateLimit: true,
          status: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      if (!tenant) {
        res.status(404).json({ error: "Tenant not found" });
        return;
      }

      res.json(tenant);
    } catch (error) {
      console.error("[Tenants] GET /v1/tenants/:id error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ---------- PATCH /v1/tenants/:id — Update tenant ----------

  router.patch("/v1/tenants/:id", async (req, res: Response) => {
    try {
      const authReq = req as unknown as AuthenticatedRequest;
      if (!requireAdmin(authReq, res)) return;

      const { id } = req.params;

      // Validate request body
      const parsed = UpdateTenantSchema.safeParse(req.body);
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

      // Verify tenant exists
      const existing = await prisma.tenant.findUnique({
        where: { id },
        select: { id: true },
      });

      if (!existing) {
        res.status(404).json({ error: "Tenant not found" });
        return;
      }

      const updateData: Record<string, unknown> = {};
      const { webhookUrl, rateLimit, status } = parsed.data;

      if (webhookUrl !== undefined) updateData.webhookUrl = webhookUrl;
      if (rateLimit !== undefined) updateData.rateLimit = rateLimit;
      if (status !== undefined) updateData.status = status;

      const updated = await prisma.tenant.update({
        where: { id },
        data: updateData,
        select: {
          id: true,
          name: true,
          custodyModel: true,
          webhookUrl: true,
          rateLimit: true,
          status: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      res.json(updated);
    } catch (error) {
      console.error("[Tenants] PATCH /v1/tenants/:id error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ---------- POST /v1/tenants/:id/rotate-key — Rotate API key ----------

  router.post("/v1/tenants/:id/rotate-key", async (req, res: Response) => {
    try {
      const authReq = req as unknown as AuthenticatedRequest;
      if (!requireAdmin(authReq, res)) return;

      const { id } = req.params;

      // Verify tenant exists
      const existing = await prisma.tenant.findUnique({
        where: { id },
        select: { id: true },
      });

      if (!existing) {
        res.status(404).json({ error: "Tenant not found" });
        return;
      }

      const { raw, hash } = generateApiKey();

      await prisma.tenant.update({
        where: { id },
        data: { apiKeyHash: hash },
      });

      res.json({
        tenantId: id,
        apiKey: raw,
        message: "API key rotated. The old key is now invalid.",
      });
    } catch (error) {
      console.error("[Tenants] POST /v1/tenants/:id/rotate-key error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
