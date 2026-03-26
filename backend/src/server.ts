import express from "express";
import cors from "cors";
import helmet from "helmet";
import { PrismaClient } from "@prisma/client";
import { loadConfig } from "./config/index.js";
import { createRedisClient } from "./lib/redis.js";
import { createBlockchainClients } from "./lib/blockchain.js";
import { AuthorizationEngine } from "./services/authorization-engine.js";
import { SettlementService } from "./services/settlement-service.js";
import { Watcher } from "./services/watcher.js";
import { WebhookDispatcher } from "./services/webhook-dispatcher.js";
import { LithicClient, MockLithicClient } from "./integrations/lithic.js";
import { requireAuth } from "./middleware/auth.js";
import { rateLimit } from "./middleware/rate-limit.js";
import { createHealthRouter } from "./routes/health.js";
import { createUsersRouter } from "./routes/users.js";
import { createCardsRouter } from "./routes/cards.js";
import { createWebhooksRouter } from "./routes/webhooks.js";

// ============ Main ============

async function main(): Promise<void> {
  // ── Load config ──
  const config = loadConfig();
  console.log(
    `[Server] Starting MultiSubs backend (env=${config.nodeEnv}, port=${config.port})`,
  );

  // ── Initialize Prisma ──
  const prisma = new PrismaClient();
  await prisma.$connect();
  console.log("[Server] Prisma connected");

  // ── Initialize Redis ──
  const redis = createRedisClient(config.redisUrl);
  await redis.connect();
  console.log("[Server] Redis connected");

  // ── Initialize Blockchain Clients ──
  const { publicClient, walletClient } = createBlockchainClients(config);
  console.log(
    `[Server] Blockchain clients initialized (chainId=${config.chainId})`,
  );

  // ── Initialize Lithic Client ──
  let lithicClient: LithicClient;
  if (config.lithicEnvironment === "sandbox" && !config.lithicApiKey) {
    lithicClient = new MockLithicClient(
      config.lithicWebhookSecret || "dev-webhook-secret",
    );
    console.log("[Server] Using MockLithicClient (sandbox, no API key)");
  } else if (config.lithicApiKey && config.lithicWebhookSecret) {
    lithicClient = new LithicClient(
      config.lithicApiKey,
      config.lithicWebhookSecret,
      config.lithicEnvironment,
    );
    console.log(
      `[Server] LithicClient initialized (env=${config.lithicEnvironment})`,
    );
  } else {
    lithicClient = new MockLithicClient(
      config.lithicWebhookSecret || "dev-webhook-secret",
    );
    console.log("[Server] Using MockLithicClient (missing credentials)");
  }

  // ── Initialize Services ──
  const authorizationEngine = new AuthorizationEngine(redis, prisma);
  console.log("[Server] AuthorizationEngine initialized");

  const webhookDispatcher = new WebhookDispatcher(prisma, redis);
  console.log("[Server] WebhookDispatcher initialized");

  let settlementService: SettlementService | null = null;
  if (walletClient) {
    settlementService = new SettlementService(
      config,
      walletClient,
      publicClient,
      prisma,
    );
    settlementService.start();
    console.log("[Server] SettlementService started");
  } else {
    console.warn(
      "[Server] SettlementService skipped — no settler private key configured",
    );
  }

  const watcher = new Watcher(
    config,
    publicClient,
    prisma,
    redis,
    (deposit) => {
      // Dispatch deposit webhook to tenant
      const tenantId = ""; // Watcher handles tenant lookup internally
      console.log(
        `[Server] Deposit callback: ${deposit.amount} to ${deposit.to} (tx: ${deposit.txHash})`,
      );
    },
  );
  watcher.start();
  console.log("[Server] Watcher started");

  // ── Create Express App ──
  const app = express();

  // ── Global Middleware ──
  app.use(helmet());
  app.use(
    cors({
      origin: config.corsOrigin,
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "X-API-Key", "X-Test-Tenant-Id"],
    }),
  );
  app.use(express.json({ limit: "1mb" }));

  // ── Mount Health Route (no auth required) ──
  app.use(createHealthRouter({ prisma, redis, watcher }));

  // ── Mount Webhook Routes (HMAC auth, no API key auth) ──
  app.use(
    createWebhooksRouter({
      authorizationEngine,
      lithicClient,
      webhookDispatcher,
    }),
  );

  // ── Auth + Rate Limit Middleware for API routes ──
  const authMiddleware = requireAuth(prisma);
  const rateLimitMiddleware = rateLimit(
    redis,
    config.nodeEnv === "development" ? 10_000 : 1000,
  );

  // ── Mount Authenticated API Routes ──
  // Apply auth and rate limit as app-level middleware for /v1 paths
  const usersRouter = createUsersRouter({ prisma });
  const cardsRouter = createCardsRouter({ prisma, lithicClient, redis });

  app.use("/v1", authMiddleware as express.RequestHandler);
  app.use("/v1", rateLimitMiddleware as express.RequestHandler);
  app.use(usersRouter);
  app.use(cardsRouter);

  // ── 404 Handler ──
  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // ── Error Handler ──
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error("[Server] Unhandled error:", err);
      res.status(500).json({ error: "Internal server error" });
    },
  );

  // ── Start Server ──
  const server = app.listen(config.port, () => {
    console.log(`[Server] Listening on port ${config.port}`);
  });

  // ── Graceful Shutdown ──
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[Server] Received ${signal} — shutting down gracefully`);

    // Stop accepting new connections
    server.close(() => {
      console.log("[Server] HTTP server closed");
    });

    // Stop services
    watcher.stop();
    if (settlementService) {
      settlementService.stop();
    }

    // Disconnect clients
    try {
      await redis.quit();
      console.log("[Server] Redis disconnected");
    } catch (err) {
      console.error("[Server] Error disconnecting Redis:", err);
    }

    try {
      await prisma.$disconnect();
      console.log("[Server] Prisma disconnected");
    } catch (err) {
      console.error("[Server] Error disconnecting Prisma:", err);
    }

    console.log("[Server] Shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// ── Entry Point ──
main().catch((err) => {
  console.error("[Server] Fatal startup error:", err);
  process.exit(1);
});
