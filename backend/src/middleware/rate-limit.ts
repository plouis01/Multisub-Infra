import type { Request, Response, NextFunction } from "express";
import type { Redis } from "ioredis";
import { checkRateLimit } from "../lib/redis.js";
import type { AuthenticatedRequest } from "./auth.js";

// ============ Rate Limit Middleware Factory ============

/**
 * Creates a Redis-backed sliding window rate limiter.
 *
 * Uses the tenant's configured rate limit (default 1000 requests per minute).
 * Returns 429 with a Retry-After header when the limit is exceeded.
 */
export function rateLimit(redis: Redis, defaultLimit = 1000) {
  return async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const tenantId = req.tenantId;
      if (!tenantId) {
        // If auth middleware didn't run or failed, skip rate limiting
        next();
        return;
      }

      const limit = defaultLimit;
      const windowSeconds = 60;

      const { allowed, remaining } = await checkRateLimit(
        redis,
        tenantId,
        limit,
        windowSeconds,
      );

      // Always set rate limit headers
      res.setHeader("X-RateLimit-Limit", limit);
      res.setHeader("X-RateLimit-Remaining", remaining);

      if (!allowed) {
        res.setHeader("Retry-After", windowSeconds);
        res.status(429).json({
          error: "Rate limit exceeded",
          retryAfter: windowSeconds,
        });
        return;
      }

      next();
    } catch (error) {
      // Rate limit check failed — allow the request through rather than
      // blocking legitimate traffic due to a Redis outage.
      console.error("[RateLimit] middleware error:", error);
      next();
    }
  };
}

// ============ Webhook Rate Limit ============

/**
 * IP-based rate limiter for webhook endpoints.
 *
 * Uses the same Redis sliding window as the tenant rate limiter but keyed
 * by source IP instead of tenant ID.
 */
export function webhookRateLimit(redis: Redis, maxPerMinute = 300) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const { allowed, remaining } = await checkRateLimit(
        redis,
        `webhook-ip:${ip}`,
        maxPerMinute,
        60,
      );
      res.setHeader("X-RateLimit-Limit", maxPerMinute.toString());
      res.setHeader("X-RateLimit-Remaining", remaining.toString());
      if (!allowed) {
        res.status(429).json({ error: "Rate limit exceeded" });
        return;
      }
      next();
    } catch {
      next(); // Fail open
    }
  };
}
