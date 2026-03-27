/**
 * Test suite for loadConfig.
 *
 * Covers: default values, type coercion, CORS validation, and env var loading.
 * Uses process.env manipulation with save/restore per test.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../src/config/index.js";

describe("loadConfig", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    // Clear all config-related env vars so defaults are used
    const configKeys = [
      "PORT",
      "CORS_ORIGIN",
      "NODE_ENV",
      "BASE_SEPOLIA_RPC_URL",
      "BASE_MAINNET_RPC_URL",
      "CHAIN_ID",
      "SPEND_SETTLER_ADDRESS",
      "M1_TREASURY_ADDRESS",
      "PLATFORM_ISSUER_SAFE_ADDRESS",
      "USDC_ADDRESS",
      "SETTLER_PRIVATE_KEY",
      "DATABASE_URL",
      "REDIS_URL",
      "LITHIC_API_KEY",
      "LITHIC_WEBHOOK_SECRET",
      "LITHIC_ENVIRONMENT",
      "WATCHER_POLL_INTERVAL_MS",
      "WATCHER_START_BLOCK",
      "SETTLEMENT_MAX_RETRIES",
      "SETTLEMENT_GAS_BUMP_PERCENT",
      "SWEEP_INTERVAL_MS",
      "SWEEP_THRESHOLD",
      "YIELD_SNAPSHOT_INTERVAL_MS",
      "MORPHO_VAULT_ADDRESS",
      "TREASURY_VAULT_ADDRESS",
      "SUMSUB_APP_TOKEN",
      "SUMSUB_SECRET_KEY",
      "SUMSUB_LEVEL_NAME",
      "ADMIN_TENANT_ID",
    ];
    for (const key of configKeys) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  // ================================================================
  // Defaults
  // ================================================================

  it("returns default values when no env vars are set", () => {
    const config = loadConfig();

    expect(config.port).toBe(3000);
    expect(config.corsOrigin).toBe("http://localhost:5173");
    expect(config.nodeEnv).toBe("development");
    expect(config.rpcUrl).toBe("https://sepolia.base.org");
    expect(config.chainId).toBe(84532);
    expect(config.spendSettlerAddress).toBe("");
    expect(config.m1TreasuryAddress).toBe("");
    expect(config.platformIssuerSafeAddress).toBe("");
    expect(config.usdcAddress).toBe(
      "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    );
    expect(config.settlerPrivateKey).toBe("");
    expect(config.databaseUrl).toBe(
      "postgresql://multisubs:multisubs@localhost:5432/multisubs",
    );
    expect(config.redisUrl).toBe("redis://localhost:6379");
    expect(config.lithicApiKey).toBe("");
    expect(config.lithicWebhookSecret).toBe("");
    expect(config.lithicEnvironment).toBe("sandbox");
    expect(config.watcherPollIntervalMs).toBe(3000);
    expect(config.watcherStartBlock).toBe(0);
    expect(config.settlementMaxRetries).toBe(3);
    expect(config.settlementGasBumpPercent).toBe(20);
    expect(config.sweepIntervalMs).toBe(900_000);
    expect(config.sweepThreshold).toBe("100000000");
    expect(config.yieldSnapshotIntervalMs).toBe(14_400_000);
    expect(config.morphoVaultAddress).toBe("");
    expect(config.treasuryVaultAddress).toBe("");
    expect(config.sumsubAppToken).toBe("");
    expect(config.sumsubSecretKey).toBe("");
    expect(config.sumsubLevelName).toBe("basic-kyc-level");
    expect(config.adminTenantId).toBe("__unset__");
  });

  // ================================================================
  // Type coercion
  // ================================================================

  it("parses PORT as a number", () => {
    process.env.PORT = "8080";

    const config = loadConfig();

    expect(config.port).toBe(8080);
    expect(typeof config.port).toBe("number");
  });

  it("parses CHAIN_ID as a number", () => {
    process.env.CHAIN_ID = "8453";

    const config = loadConfig();

    expect(config.chainId).toBe(8453);
    expect(typeof config.chainId).toBe("number");
  });

  // ================================================================
  // CORS validation
  // ================================================================

  it("validates corsOrigin rejects '*' in non-development", () => {
    process.env.CORS_ORIGIN = "*";
    process.env.NODE_ENV = "production";

    expect(() => loadConfig()).toThrow();
  });

  it("allows corsOrigin '*' in development", () => {
    process.env.CORS_ORIGIN = "*";
    process.env.NODE_ENV = "development";

    const config = loadConfig();

    expect(config.corsOrigin).toBe("*");
  });

  // ================================================================
  // adminTenantId
  // ================================================================

  it("adminTenantId defaults to '__unset__'", () => {
    const config = loadConfig();

    expect(config.adminTenantId).toBe("__unset__");
  });

  it("adminTenantId reads from env var", () => {
    process.env.ADMIN_TENANT_ID = "tenant-admin-001";

    const config = loadConfig();

    expect(config.adminTenantId).toBe("tenant-admin-001");
  });

  // ================================================================
  // Full env var loading
  // ================================================================

  it("loads all env vars correctly when set", () => {
    process.env.PORT = "4000";
    process.env.CORS_ORIGIN = "https://app.example.com";
    process.env.NODE_ENV = "production";
    process.env.BASE_SEPOLIA_RPC_URL = "https://custom-rpc.example.com";
    process.env.CHAIN_ID = "1";
    process.env.SPEND_SETTLER_ADDRESS = "0xSettler";
    process.env.M1_TREASURY_ADDRESS = "0xTreasury";
    process.env.PLATFORM_ISSUER_SAFE_ADDRESS = "0xSafe";
    process.env.USDC_ADDRESS = "0xUSDC";
    process.env.SETTLER_PRIVATE_KEY = "0xprivatekey";
    process.env.DATABASE_URL = "postgresql://user:pass@db:5432/prod";
    process.env.REDIS_URL = "redis://redis:6379";
    process.env.LITHIC_API_KEY = "lithic-key-123";
    process.env.LITHIC_WEBHOOK_SECRET = "whsec_prod_secret";
    process.env.LITHIC_ENVIRONMENT = "production";
    process.env.WATCHER_POLL_INTERVAL_MS = "5000";
    process.env.WATCHER_START_BLOCK = "100";
    process.env.SETTLEMENT_MAX_RETRIES = "5";
    process.env.SETTLEMENT_GAS_BUMP_PERCENT = "30";
    process.env.SWEEP_INTERVAL_MS = "600000";
    process.env.SWEEP_THRESHOLD = "200000000";
    process.env.YIELD_SNAPSHOT_INTERVAL_MS = "7200000";
    process.env.MORPHO_VAULT_ADDRESS = "0xMorpho";
    process.env.TREASURY_VAULT_ADDRESS = "0xTreasuryVault";
    process.env.SUMSUB_APP_TOKEN = "sumsub-token";
    process.env.SUMSUB_SECRET_KEY = "sumsub-secret";
    process.env.SUMSUB_LEVEL_NAME = "advanced-kyc";
    process.env.ADMIN_TENANT_ID = "admin-tenant-prod";

    const config = loadConfig();

    expect(config.port).toBe(4000);
    expect(config.corsOrigin).toBe("https://app.example.com");
    expect(config.nodeEnv).toBe("production");
    expect(config.rpcUrl).toBe("https://custom-rpc.example.com");
    expect(config.chainId).toBe(1);
    expect(config.spendSettlerAddress).toBe("0xSettler");
    expect(config.m1TreasuryAddress).toBe("0xTreasury");
    expect(config.platformIssuerSafeAddress).toBe("0xSafe");
    expect(config.usdcAddress).toBe("0xUSDC");
    expect(config.settlerPrivateKey).toBe("0xprivatekey");
    expect(config.databaseUrl).toBe("postgresql://user:pass@db:5432/prod");
    expect(config.redisUrl).toBe("redis://redis:6379");
    expect(config.lithicApiKey).toBe("lithic-key-123");
    expect(config.lithicWebhookSecret).toBe("whsec_prod_secret");
    expect(config.lithicEnvironment).toBe("production");
    expect(config.watcherPollIntervalMs).toBe(5000);
    expect(config.watcherStartBlock).toBe(100);
    expect(config.settlementMaxRetries).toBe(5);
    expect(config.settlementGasBumpPercent).toBe(30);
    expect(config.sweepIntervalMs).toBe(600000);
    expect(config.sweepThreshold).toBe("200000000");
    expect(config.yieldSnapshotIntervalMs).toBe(7200000);
    expect(config.morphoVaultAddress).toBe("0xMorpho");
    expect(config.treasuryVaultAddress).toBe("0xTreasuryVault");
    expect(config.sumsubAppToken).toBe("sumsub-token");
    expect(config.sumsubSecretKey).toBe("sumsub-secret");
    expect(config.sumsubLevelName).toBe("advanced-kyc");
    expect(config.adminTenantId).toBe("admin-tenant-prod");
  });
});
