import { createHash } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";

// ============ Types ============

export interface AuthenticatedRequest extends Request {
  tenantId: string;
}

// ============ Auth Middleware Factory ============

/**
 * Creates an API key authentication middleware.
 *
 * Extracts the API key from the `X-API-Key` header, hashes it with SHA-256,
 * and looks up the matching tenant in the database. Attaches `tenantId` to the
 * request object on success; returns 401/403 on failure.
 *
 * In development mode, `X-Test-Tenant-Id` may be used to bypass key lookup.
 */
export function requireAuth(prisma: PrismaClient) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      // Test auth bypass: requires explicit opt-in and non-production environment
      if (
        process.env.ALLOW_TEST_AUTH === "true" &&
        process.env.NODE_ENV !== "production"
      ) {
        const testTenantId = req.headers["x-test-tenant-id"];
        if (typeof testTenantId === "string" && testTenantId.length > 0) {
          // Verify test tenant exists in DB
          const exists = await prisma.tenant.findUnique({
            where: { id: testTenantId },
            select: { id: true },
          });
          if (exists) {
            (req as AuthenticatedRequest).tenantId = testTenantId;
            next();
            return;
          }
        }
      }

      // Extract API key from header
      const apiKey = req.headers["x-api-key"];
      if (typeof apiKey !== "string" || apiKey.length === 0) {
        res.status(401).json({ error: "Missing or invalid X-API-Key header" });
        return;
      }

      // Hash the API key with SHA-256
      const apiKeyHash = createHash("sha256").update(apiKey).digest("hex");

      // Lookup tenant by hashed key
      const tenant = await prisma.tenant.findUnique({
        where: { apiKeyHash },
        select: {
          id: true,
          status: true,
          rateLimit: true,
        },
      });

      if (!tenant) {
        res.status(401).json({ error: "Invalid API key" });
        return;
      }

      // Check tenant status
      if (tenant.status === "suspended") {
        res.status(403).json({ error: "Tenant account is suspended" });
        return;
      }

      if (tenant.status === "disabled") {
        res.status(403).json({ error: "Tenant account is disabled" });
        return;
      }

      if (tenant.status !== "active") {
        res.status(403).json({ error: "Account access denied" });
        return;
      }

      // Attach tenant info to request
      (req as AuthenticatedRequest).tenantId = tenant.id;

      next();
    } catch (error) {
      console.error("[Auth] middleware error:", error);
      res.status(500).json({ error: "Internal authentication error" });
    }
  };
}
