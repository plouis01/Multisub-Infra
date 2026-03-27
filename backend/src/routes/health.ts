import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import type { Watcher } from "../services/watcher.js";

// ============ Types ============

interface HealthDeps {
  prisma: PrismaClient;
  redis: Redis;
  watcher: Watcher | null;
}

interface ComponentHealth {
  status: "ok" | "degraded" | "down";
  latencyMs?: number;
  detail?: string;
}

// ============ Health Check Router ============

export function createHealthRouter(deps: HealthDeps): Router {
  const router = Router();

  router.get("/health", async (_req, res) => {
    const components: Record<string, ComponentHealth> = {};
    let overall: "ok" | "degraded" | "down" = "ok";

    // Check database
    try {
      const dbStart = performance.now();
      await deps.prisma.$queryRaw`SELECT 1`;
      const dbLatency = Math.round(performance.now() - dbStart);
      components.database = { status: "ok", latencyMs: dbLatency };
    } catch (error) {
      console.error("[Health] Database check failed:", error);
      components.database = {
        status: "down",
        detail: "Connection failed",
      };
      overall = "down";
    }

    // Check Redis
    try {
      const redisStart = performance.now();
      await deps.redis.ping();
      const redisLatency = Math.round(performance.now() - redisStart);
      components.redis = { status: "ok", latencyMs: redisLatency };
    } catch (error) {
      console.error("[Health] Redis check failed:", error);
      components.redis = {
        status: "down",
        detail: "Connection failed",
      };
      overall = overall === "down" ? "down" : "degraded";
    }

    // Check Watcher
    if (deps.watcher) {
      const lastPoll = deps.watcher.lastPollAt;
      const stalenessMs = lastPoll > 0 ? Date.now() - lastPoll : Infinity;

      if (lastPoll === 0) {
        components.watcher = {
          status: "degraded",
          detail: "Watcher has not completed a poll yet",
        };
        if (overall === "ok") overall = "degraded";
      } else if (stalenessMs > 60_000) {
        components.watcher = {
          status: "degraded",
          detail: `Last poll ${Math.round(stalenessMs / 1000)}s ago`,
        };
        if (overall === "ok") overall = "degraded";
      } else {
        components.watcher = {
          status: "ok",
          detail: `Last poll ${Math.round(stalenessMs / 1000)}s ago`,
        };
      }
    } else {
      components.watcher = { status: "ok", detail: "Not configured" };
    }

    const statusCode = overall === "down" ? 503 : 200;

    res.status(statusCode).json({
      status: overall,
      timestamp: new Date().toISOString(),
      components,
    });
  });

  return router;
}
