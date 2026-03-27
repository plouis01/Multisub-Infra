/**
 * Test suite for the YieldManager and SweepService.
 *
 * Covers: yield snapshot calculation, sweep threshold logic,
 * issuer safe top-up, yield summary queries, and service lifecycle.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createMockPrisma,
  createMockRedis,
  createMockPublicClient,
  createMockWalletClient,
  resetIdCounter,
  type MockPrismaClient,
  type MockRedisClient,
} from "./mocks.js";
import {
  YieldManager,
  ALLOCATION_PLATFORM_BPS,
  ALLOCATION_TENANT_BPS,
  ALLOCATION_RESERVE_BPS,
  type AllocationResult,
} from "../src/services/yield-manager.js";
import { SweepService } from "../src/services/sweep-service.js";
import type { Config } from "../src/config/index.js";

// ============ Helpers ============

function createTestConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 3000,
    corsOrigin: "http://localhost:5173",
    nodeEnv: "test",
    rpcUrl: "https://sepolia.base.org",
    chainId: 84532,
    spendSettlerAddress: "0x" + "1".repeat(40),
    m1TreasuryAddress: "0x" + "2".repeat(40),
    platformIssuerSafeAddress: "0x" + "3".repeat(40),
    usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    settlerPrivateKey: "",
    databaseUrl: "postgresql://localhost:5432/test",
    redisUrl: "redis://localhost:6379",
    lithicApiKey: "",
    lithicWebhookSecret: "",
    lithicEnvironment: "sandbox",
    watcherPollIntervalMs: 3000,
    watcherStartBlock: 0,
    settlementMaxRetries: 3,
    settlementGasBumpPercent: 20,
    sweepIntervalMs: 900_000,
    sweepThreshold: "100000000", // $100 USDC
    yieldSnapshotIntervalMs: 14_400_000,
    morphoVaultAddress: "0x" + "4".repeat(40),
    treasuryVaultAddress: "0x" + "5".repeat(40),
    ...overrides,
  };
}

// ============ YieldManager Tests ============

describe("YieldManager", () => {
  let config: Config;
  let prisma: MockPrismaClient;
  let redis: MockRedisClient;
  let publicClient: ReturnType<typeof createMockPublicClient>;
  let walletClient: ReturnType<typeof createMockWalletClient>;
  let yieldManager: YieldManager;

  beforeEach(() => {
    resetIdCounter();
    config = createTestConfig();
    prisma = createMockPrisma();
    redis = createMockRedis();
    publicClient = createMockPublicClient();
    walletClient = createMockWalletClient();

    // Add yieldLedger mock to prisma
    (prisma as any).yieldLedger = {
      create: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    };

    // Add tenant mock to prisma
    prisma.tenant.findMany.mockResolvedValue([]);

    yieldManager = new YieldManager(
      config,
      publicClient as any,
      walletClient as any,
      prisma as any,
      redis as any,
    );

    // Mark as running so methods execute
    (yieldManager as any).running = true;
  });

  afterEach(() => {
    yieldManager.stop();
    vi.restoreAllMocks();
  });

  // ----------------------------------------------------------------
  // Lifecycle
  // ----------------------------------------------------------------

  describe("lifecycle", () => {
    it("starts and sets running to true", () => {
      // Reset running to false first
      (yieldManager as any).running = false;
      yieldManager.start();
      expect((yieldManager as any).running).toBe(true);
    });

    it("ignores duplicate start() calls", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      yieldManager.start(); // already running from beforeEach setup
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("already running"),
      );
    });

    it("stops and clears all timers", () => {
      yieldManager.stop();
      expect((yieldManager as any).running).toBe(false);
      expect((yieldManager as any).sweepTimer).toBeNull();
      expect((yieldManager as any).snapshotTimer).toBeNull();
      expect((yieldManager as any).topUpTimer).toBeNull();
    });
  });

  // ----------------------------------------------------------------
  // Sweep
  // ----------------------------------------------------------------

  describe("sweep", () => {
    it("skips M2 Safes below sweep threshold", async () => {
      prisma.user.findMany.mockResolvedValue([
        {
          id: "user-1",
          tenantId: "tenant-1",
          m2SafeAddress: "0x" + "a".repeat(40),
        },
      ]);

      // Balance of 50 USDC (below 100 USDC threshold)
      publicClient.readContract.mockResolvedValue(50_000_000n);

      const count = await yieldManager.sweep();

      expect(count).toBe(0);
      // Should not attempt to send a transaction
      expect(walletClient.sendTransaction).not.toHaveBeenCalled();
    });

    it("sweeps M2 Safes above threshold", async () => {
      prisma.user.findMany.mockResolvedValue([
        {
          id: "user-1",
          tenantId: "tenant-1",
          m2SafeAddress: "0x" + "a".repeat(40),
        },
      ]);

      // Balance of 500 USDC (above 100 USDC threshold)
      publicClient.readContract.mockResolvedValue(500_000_000n);

      // Mock successful tx
      walletClient.sendTransaction.mockResolvedValue(
        ("0x" + "d".repeat(64)) as `0x${string}`,
      );
      publicClient.waitForTransactionReceipt.mockResolvedValue({
        status: "success",
        blockNumber: 1234n,
        transactionHash: "0x" + "d".repeat(64),
      });

      const count = await yieldManager.sweep();

      expect(count).toBe(1);
      expect(walletClient.sendTransaction).toHaveBeenCalled();
      expect(prisma.balanceLedger.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: "sweep",
            amount: "500000000",
          }),
        }),
      );
    });

    it("sweeps exact threshold amount (equal is not swept)", async () => {
      prisma.user.findMany.mockResolvedValue([
        {
          id: "user-1",
          tenantId: "tenant-1",
          m2SafeAddress: "0x" + "a".repeat(40),
        },
      ]);

      // Balance exactly at threshold: 100 USDC
      publicClient.readContract.mockResolvedValue(100_000_000n);

      const count = await yieldManager.sweep();

      expect(count).toBe(0);
      expect(walletClient.sendTransaction).not.toHaveBeenCalled();
    });

    it("handles multiple M2 Safes in one cycle", async () => {
      prisma.user.findMany.mockResolvedValue([
        {
          id: "user-1",
          tenantId: "tenant-1",
          m2SafeAddress: "0x" + "a".repeat(40),
        },
        {
          id: "user-2",
          tenantId: "tenant-1",
          m2SafeAddress: "0x" + "b".repeat(40),
        },
        {
          id: "user-3",
          tenantId: "tenant-2",
          m2SafeAddress: "0x" + "c".repeat(40),
        },
      ]);

      // First user: above threshold, second: below, third: above
      publicClient.readContract
        .mockResolvedValueOnce(200_000_000n)
        .mockResolvedValueOnce(50_000_000n)
        .mockResolvedValueOnce(300_000_000n);

      walletClient.sendTransaction.mockResolvedValue(
        ("0x" + "d".repeat(64)) as `0x${string}`,
      );
      publicClient.waitForTransactionReceipt.mockResolvedValue({
        status: "success",
        blockNumber: 1234n,
        transactionHash: "0x" + "d".repeat(64),
      });

      const count = await yieldManager.sweep();

      expect(count).toBe(2);
      expect(walletClient.sendTransaction).toHaveBeenCalledTimes(2);
    });

    it("returns 0 when no users found", async () => {
      prisma.user.findMany.mockResolvedValue([]);

      const count = await yieldManager.sweep();

      expect(count).toBe(0);
    });

    it("continues sweeping other safes if one fails", async () => {
      prisma.user.findMany.mockResolvedValue([
        {
          id: "user-1",
          tenantId: "tenant-1",
          m2SafeAddress: "0x" + "a".repeat(40),
        },
        {
          id: "user-2",
          tenantId: "tenant-1",
          m2SafeAddress: "0x" + "b".repeat(40),
        },
      ]);

      // First: above threshold but tx fails; Second: above threshold and succeeds
      publicClient.readContract
        .mockResolvedValueOnce(200_000_000n) // user-1 balance
        .mockResolvedValueOnce(300_000_000n); // user-2 balance

      walletClient.sendTransaction
        .mockRejectedValueOnce(new Error("tx failed"))
        .mockResolvedValueOnce(("0x" + "d".repeat(64)) as `0x${string}`);

      publicClient.waitForTransactionReceipt.mockResolvedValue({
        status: "success",
        blockNumber: 1234n,
        transactionHash: "0x" + "d".repeat(64),
      });

      const count = await yieldManager.sweep();

      expect(count).toBe(1);
    });
  });

  // ----------------------------------------------------------------
  // Yield Snapshot
  // ----------------------------------------------------------------

  describe("snapshotYield", () => {
    it("records yield snapshot for active tenants", async () => {
      prisma.tenant.findMany.mockResolvedValue([
        { id: "tenant-1", name: "Acme" },
      ]);

      // getTenantPosition returns [deposited, shares, lastDepositTimestamp]
      publicClient.readContract
        .mockResolvedValueOnce([
          1_000_000_000n, // deposited: 1000 USDC
          500_000n, // shares
          1700000000n, // lastDepositTimestamp
        ])
        // convertToAssets returns current value
        .mockResolvedValueOnce(1_050_000_000n); // 1050 USDC (50 USDC yield)

      const results = await yieldManager.snapshotYield();

      expect(results).toHaveLength(1);
      expect(results[0].tenantId).toBe("tenant-1");
      expect(results[0].totalDeposited).toBe("1000000000");
      expect(results[0].totalShares).toBe("500000");
      expect(results[0].totalYield).toBe("50000000"); // 50 USDC
      // APY bps: (50_000_000 * 10000) / 1_000_000_000 = 500 bps = 5%
      expect(results[0].apyBps).toBe(500);

      expect((prisma as any).yieldLedger.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: "tenant-1",
            totalDeposited: "1000000000",
            totalShares: "500000",
            totalYield: "50000000",
            apyBps: 500,
          }),
        }),
      );
    });

    it("skips tenants with zero shares", async () => {
      prisma.tenant.findMany.mockResolvedValue([
        { id: "tenant-1", name: "Acme" },
      ]);

      // Zero shares position
      publicClient.readContract.mockResolvedValueOnce([0n, 0n, 0n]);

      const results = await yieldManager.snapshotYield();

      expect(results).toHaveLength(0);
      expect((prisma as any).yieldLedger.create).not.toHaveBeenCalled();
    });

    it("handles zero deposited (no division by zero for APY)", async () => {
      prisma.tenant.findMany.mockResolvedValue([
        { id: "tenant-1", name: "Acme" },
      ]);

      // Shares exist but deposited is somehow 0
      publicClient.readContract
        .mockResolvedValueOnce([0n, 100n, 0n])
        .mockResolvedValueOnce(50_000_000n);

      const results = await yieldManager.snapshotYield();

      expect(results).toHaveLength(1);
      expect(results[0].apyBps).toBe(0); // No division by zero
    });

    it("records zero yield when currentValue equals deposited", async () => {
      prisma.tenant.findMany.mockResolvedValue([
        { id: "tenant-1", name: "Acme" },
      ]);

      publicClient.readContract
        .mockResolvedValueOnce([1_000_000_000n, 500_000n, 0n])
        .mockResolvedValueOnce(1_000_000_000n); // Same as deposited

      const results = await yieldManager.snapshotYield();

      expect(results).toHaveLength(1);
      expect(results[0].totalYield).toBe("0");
      expect(results[0].apyBps).toBe(0);
    });

    it("records zero yield when currentValue is less than deposited (loss)", async () => {
      prisma.tenant.findMany.mockResolvedValue([
        { id: "tenant-1", name: "Acme" },
      ]);

      publicClient.readContract
        .mockResolvedValueOnce([1_000_000_000n, 500_000n, 0n])
        .mockResolvedValueOnce(950_000_000n); // 50 USDC loss

      const results = await yieldManager.snapshotYield();

      expect(results).toHaveLength(1);
      // Loss is recorded as 0 yield (not negative)
      expect(results[0].totalYield).toBe("0");
      expect(results[0].apyBps).toBe(0);
    });

    it("skips snapshot when vault addresses not configured", async () => {
      const noVaultConfig = createTestConfig({
        morphoVaultAddress: "",
        treasuryVaultAddress: "",
      });
      const noVaultManager = new YieldManager(
        noVaultConfig,
        publicClient as any,
        walletClient as any,
        prisma as any,
        redis as any,
      );
      (noVaultManager as any).running = true;

      const results = await noVaultManager.snapshotYield();

      expect(results).toHaveLength(0);
      expect(prisma.tenant.findMany).not.toHaveBeenCalled();

      noVaultManager.stop();
    });

    it("handles multiple tenants in one snapshot", async () => {
      prisma.tenant.findMany.mockResolvedValue([
        { id: "tenant-1", name: "Acme" },
        { id: "tenant-2", name: "Beta" },
      ]);

      publicClient.readContract
        // Tenant 1: getTenantPosition
        .mockResolvedValueOnce([1_000_000_000n, 500_000n, 0n])
        // Tenant 1: convertToAssets
        .mockResolvedValueOnce(1_050_000_000n)
        // Tenant 2: getTenantPosition
        .mockResolvedValueOnce([2_000_000_000n, 1_000_000n, 0n])
        // Tenant 2: convertToAssets
        .mockResolvedValueOnce(2_200_000_000n);

      const results = await yieldManager.snapshotYield();

      expect(results).toHaveLength(2);
      expect(results[0].totalYield).toBe("50000000"); // 50 USDC
      expect(results[1].totalYield).toBe("200000000"); // 200 USDC
      // Tenant 2 APY: (200_000_000 * 10000) / 2_000_000_000 = 1000 bps = 10%
      expect(results[1].apyBps).toBe(1000);
    });

    it("continues processing tenants even if one fails", async () => {
      prisma.tenant.findMany.mockResolvedValue([
        { id: "tenant-1", name: "Acme" },
        { id: "tenant-2", name: "Beta" },
      ]);

      publicClient.readContract
        // Tenant 1 fails
        .mockRejectedValueOnce(new Error("RPC error"))
        // Tenant 2 succeeds
        .mockResolvedValueOnce([2_000_000_000n, 1_000_000n, 0n])
        .mockResolvedValueOnce(2_100_000_000n);

      const results = await yieldManager.snapshotYield();

      expect(results).toHaveLength(1);
      expect(results[0].tenantId).toBe("tenant-2");
    });
  });

  // ----------------------------------------------------------------
  // Issuer Safe Top-Up
  // ----------------------------------------------------------------

  describe("topUpIssuerSafe", () => {
    it("tops up when issuer safe balance is below minimum", async () => {
      // Issuer safe balance: 5,000 USDC (below 10,000 minimum)
      // Treasury balance: 100,000 USDC
      publicClient.readContract
        .mockResolvedValueOnce(5_000_000_000n) // issuer balance
        .mockResolvedValueOnce(100_000_000_000n); // treasury balance

      walletClient.sendTransaction.mockResolvedValue(
        ("0x" + "e".repeat(64)) as `0x${string}`,
      );
      publicClient.waitForTransactionReceipt.mockResolvedValue({
        status: "success",
        blockNumber: 5678n,
        transactionHash: "0x" + "e".repeat(64),
      });

      const result = await yieldManager.topUpIssuerSafe();

      expect(result).toBe(true);
      expect(walletClient.sendTransaction).toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "issuer_safe_topup",
          }),
        }),
      );
    });

    it("does not top up when issuer safe balance is sufficient", async () => {
      // Issuer safe balance: 20,000 USDC (above 10,000 minimum)
      publicClient.readContract.mockResolvedValueOnce(20_000_000_000n);

      const result = await yieldManager.topUpIssuerSafe();

      expect(result).toBe(false);
      expect(walletClient.sendTransaction).not.toHaveBeenCalled();
    });

    it("does not top up when treasury has insufficient funds", async () => {
      // Issuer safe balance: 5,000 USDC (below minimum)
      // Treasury balance: 1,000 USDC (not enough for top-up)
      publicClient.readContract
        .mockResolvedValueOnce(5_000_000_000n)
        .mockResolvedValueOnce(1_000_000_000n);

      const result = await yieldManager.topUpIssuerSafe();

      expect(result).toBe(false);
      expect(walletClient.sendTransaction).not.toHaveBeenCalled();
    });

    it("returns false when issuer safe address not configured", async () => {
      const noIssuerConfig = createTestConfig({
        platformIssuerSafeAddress: "",
      });
      const noIssuerManager = new YieldManager(
        noIssuerConfig,
        publicClient as any,
        walletClient as any,
        prisma as any,
        redis as any,
      );
      (noIssuerManager as any).running = true;

      const result = await noIssuerManager.topUpIssuerSafe();

      expect(result).toBe(false);

      noIssuerManager.stop();
    });
  });

  // ----------------------------------------------------------------
  // getYieldSummary
  // ----------------------------------------------------------------

  describe("getYieldSummary", () => {
    it("returns yield summary for a tenant with a position", async () => {
      publicClient.readContract
        .mockResolvedValueOnce([
          1_000_000_000n, // deposited
          500_000n, // shares
          1700000000n, // lastDepositTimestamp
        ])
        .mockResolvedValueOnce(1_100_000_000n); // currentValue

      const summary = await yieldManager.getYieldSummary("tenant-1");

      expect(summary).not.toBeNull();
      expect(summary!.totalDeposited).toBe("1000000000");
      expect(summary!.totalShares).toBe("500000");
      expect(summary!.currentValue).toBe("1100000000");
      expect(summary!.unrealizedYield).toBe("100000000"); // 100 USDC
      expect(summary!.apyBps).toBe(1000); // 10%
    });

    it("returns zero summary for a tenant with no position", async () => {
      publicClient.readContract.mockResolvedValueOnce([0n, 0n, 0n]);

      const summary = await yieldManager.getYieldSummary("tenant-1");

      expect(summary).not.toBeNull();
      expect(summary!.totalDeposited).toBe("0");
      expect(summary!.totalShares).toBe("0");
      expect(summary!.currentValue).toBe("0");
      expect(summary!.unrealizedYield).toBe("0");
      expect(summary!.apyBps).toBe(0);
    });

    it("returns null when vault addresses not configured", async () => {
      const noVaultConfig = createTestConfig({
        morphoVaultAddress: "",
        treasuryVaultAddress: "",
      });
      const noVaultManager = new YieldManager(
        noVaultConfig,
        publicClient as any,
        walletClient as any,
        prisma as any,
        redis as any,
      );

      const summary = await noVaultManager.getYieldSummary("tenant-1");

      expect(summary).toBeNull();
    });

    it("returns null on RPC error", async () => {
      publicClient.readContract.mockRejectedValue(new Error("RPC timeout"));

      const summary = await yieldManager.getYieldSummary("tenant-1");

      expect(summary).toBeNull();
    });
  });

  // ----------------------------------------------------------------
  // Yield Allocation (60/30/10)
  // ----------------------------------------------------------------

  describe("allocateYield", () => {
    const makeSnapshot = (tenantId: string, totalYield: string) => ({
      tenantId,
      totalDeposited: "1000000000",
      totalShares: "500000",
      totalYield,
      apyBps: 500,
    });

    beforeEach(() => {
      // Default: successful tx flow
      walletClient.sendTransaction.mockResolvedValue(
        ("0x" + "f".repeat(64)) as `0x${string}`,
      );
      publicClient.waitForTransactionReceipt.mockResolvedValue({
        status: "success",
        blockNumber: 9999n,
        transactionHash: "0x" + "f".repeat(64),
      });
      // Default: a user exists for the tenant
      prisma.user.findMany.mockResolvedValue([{ id: "user-1" }]);
    });

    it("splits yield correctly at 30/60/10", async () => {
      // 100 USDC yield
      const snapshots = [makeSnapshot("tenant-1", "100000000")];

      const results = await yieldManager.allocateYield(snapshots);

      expect(results).toHaveLength(1);
      // 30% of 100_000_000 = 30_000_000
      expect(results[0].platformShare).toBe("30000000");
      // 60% of 100_000_000 = 60_000_000
      expect(results[0].tenantShare).toBe("60000000");
      // 10% of 100_000_000 = 10_000_000
      expect(results[0].reserveShare).toBe("10000000");
    });

    it("transfers platform share to issuer safe via walletClient", async () => {
      const snapshots = [makeSnapshot("tenant-1", "100000000")];

      await yieldManager.allocateYield(snapshots);

      // Verify sendTransaction was called (platform transfer)
      expect(walletClient.sendTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          to: config.m1TreasuryAddress,
        }),
      );
      // Should have waited for receipt
      expect(publicClient.waitForTransactionReceipt).toHaveBeenCalled();
    });

    it("credits tenant share to BalanceLedger as type yield", async () => {
      const snapshots = [makeSnapshot("tenant-1", "100000000")];

      await yieldManager.allocateYield(snapshots);

      // Two BalanceLedger entries: tenant share (60%) + platform share (30%)
      expect(prisma.balanceLedger.create).toHaveBeenCalledTimes(2);

      // First call: tenant share
      expect(prisma.balanceLedger.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: "tenant-1",
            type: "yield",
            amount: "60000000",
            note: expect.stringContaining("60%"),
          }),
        }),
      );
    });

    it("reserve stays untouched (no transfer or ledger entry for reserve)", async () => {
      const snapshots = [makeSnapshot("tenant-1", "100000000")];

      const results = await yieldManager.allocateYield(snapshots);

      // Only 1 sendTransaction call (platform share transfer)
      expect(walletClient.sendTransaction).toHaveBeenCalledTimes(1);

      // Reserve is simply totalYield - platform - tenant, stays in vault
      expect(results[0].reserveShare).toBe("10000000");
    });

    it("skips allocation below minimum threshold ($1)", async () => {
      // 0.50 USDC yield = 500_000 (below 1_000_000 threshold)
      const snapshots = [makeSnapshot("tenant-1", "500000")];

      const results = await yieldManager.allocateYield(snapshots);

      expect(results).toHaveLength(0);
      expect(walletClient.sendTransaction).not.toHaveBeenCalled();
      expect(prisma.balanceLedger.create).not.toHaveBeenCalled();
    });

    it("handles transaction revert gracefully", async () => {
      walletClient.sendTransaction.mockResolvedValue(
        ("0x" + "f".repeat(64)) as `0x${string}`,
      );
      publicClient.waitForTransactionReceipt.mockResolvedValue({
        status: "reverted",
        blockNumber: 9999n,
        transactionHash: "0x" + "f".repeat(64),
      });

      const snapshots = [makeSnapshot("tenant-1", "100000000")];
      const results = await yieldManager.allocateYield(snapshots);

      // Reverted tx means no result recorded
      expect(results).toHaveLength(0);
      // BalanceLedger should NOT be written on revert
      expect(prisma.balanceLedger.create).not.toHaveBeenCalled();
    });

    it("handles sendTransaction error gracefully", async () => {
      walletClient.sendTransaction.mockRejectedValue(
        new Error("gas estimation failed"),
      );

      const snapshots = [makeSnapshot("tenant-1", "100000000")];
      const results = await yieldManager.allocateYield(snapshots);

      // Error is caught per-tenant, returns empty results
      expect(results).toHaveLength(0);
    });

    it("continues processing tenants if one fails", async () => {
      walletClient.sendTransaction
        .mockRejectedValueOnce(new Error("tx failed for tenant-1"))
        .mockResolvedValueOnce(("0x" + "f".repeat(64)) as `0x${string}`);

      const snapshots = [
        makeSnapshot("tenant-1", "50000000"),
        makeSnapshot("tenant-2", "80000000"),
      ];

      const results = await yieldManager.allocateYield(snapshots);

      // Only tenant-2 succeeds
      expect(results).toHaveLength(1);
      expect(results[0].tenantId).toBe("tenant-2");
    });

    it("records audit log for each allocation", async () => {
      const snapshots = [makeSnapshot("tenant-1", "100000000")];

      await yieldManager.allocateYield(snapshots);

      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: "tenant-1",
            action: "yield_allocated",
            details: expect.objectContaining({
              platformShare: "30000000",
              tenantShare: "60000000",
              reserveShare: "10000000",
            }),
          }),
        }),
      );
    });

    it("updates lastAllocationAt timestamp", async () => {
      const before = Date.now();
      const snapshots = [makeSnapshot("tenant-1", "100000000")];

      await yieldManager.allocateYield(snapshots);

      expect(yieldManager.lastAllocationAt).toBeGreaterThanOrEqual(before);
    });

    it("returns empty when issuer safe address not configured", async () => {
      const noIssuerConfig = createTestConfig({
        platformIssuerSafeAddress: "",
      });
      const noIssuerManager = new YieldManager(
        noIssuerConfig,
        publicClient as any,
        walletClient as any,
        prisma as any,
        redis as any,
      );
      (noIssuerManager as any).running = true;

      const snapshots = [makeSnapshot("tenant-1", "100000000")];
      const results = await noIssuerManager.allocateYield(snapshots);

      expect(results).toHaveLength(0);
      expect(walletClient.sendTransaction).not.toHaveBeenCalled();

      noIssuerManager.stop();
    });

    it("handles rounding correctly for odd yield amounts", async () => {
      // 33 USDC yield -> 33_000_000
      // 60% = 19_800_000, 30% = 9_900_000, reserve = 33_000_000 - 19_800_000 - 9_900_000 = 3_300_000
      const snapshots = [makeSnapshot("tenant-1", "33000000")];

      const results = await yieldManager.allocateYield(snapshots);

      expect(results).toHaveLength(1);
      expect(results[0].platformShare).toBe("9900000");
      expect(results[0].tenantShare).toBe("19800000");
      expect(results[0].reserveShare).toBe("3300000");
      // Verify they sum to totalYield
      const sum =
        BigInt(results[0].platformShare) +
        BigInt(results[0].tenantShare) +
        BigInt(results[0].reserveShare);
      expect(sum.toString()).toBe("33000000");
    });
  });
});

// ============ SweepService Tests ============

describe("SweepService", () => {
  let config: Config;
  let prisma: MockPrismaClient;
  let publicClient: ReturnType<typeof createMockPublicClient>;
  let walletClient: ReturnType<typeof createMockWalletClient>;
  let sweepService: SweepService;

  beforeEach(() => {
    resetIdCounter();
    config = createTestConfig();
    prisma = createMockPrisma();
    publicClient = createMockPublicClient();
    walletClient = createMockWalletClient();

    sweepService = new SweepService(
      config,
      publicClient as any,
      walletClient as any,
      prisma as any,
    );

    // Mark as running so runSweepCycle executes
    (sweepService as any).running = true;
  });

  afterEach(() => {
    sweepService.stop();
    vi.restoreAllMocks();
  });

  // ----------------------------------------------------------------
  // Lifecycle
  // ----------------------------------------------------------------

  describe("lifecycle", () => {
    it("starts and sets running to true", () => {
      (sweepService as any).running = false;
      sweepService.start();
      expect((sweepService as any).running).toBe(true);
    });

    it("stops and clears timer", () => {
      sweepService.stop();
      expect((sweepService as any).running).toBe(false);
      expect((sweepService as any).timer).toBeNull();
    });
  });

  // ----------------------------------------------------------------
  // runSweepCycle
  // ----------------------------------------------------------------

  describe("runSweepCycle", () => {
    it("returns empty array when no users", async () => {
      prisma.user.findMany.mockResolvedValue([]);

      const results = await sweepService.runSweepCycle();

      expect(results).toHaveLength(0);
    });

    it("sweeps M2 Safe above threshold", async () => {
      prisma.user.findMany.mockResolvedValue([
        {
          id: "user-1",
          tenantId: "tenant-1",
          m2SafeAddress: "0x" + "a".repeat(40),
        },
      ]);

      publicClient.readContract.mockResolvedValue(200_000_000n); // 200 USDC
      walletClient.sendTransaction.mockResolvedValue(
        ("0x" + "f".repeat(64)) as `0x${string}`,
      );
      publicClient.waitForTransactionReceipt.mockResolvedValue({
        status: "success",
        blockNumber: 999n,
        transactionHash: "0x" + "f".repeat(64),
      });

      const results = await sweepService.runSweepCycle();

      expect(results).toHaveLength(1);
      expect(results[0].amount).toBe("200000000");
      expect(results[0].m2SafeAddress).toBe("0x" + "a".repeat(40));
    });

    it("skips M2 Safe below threshold", async () => {
      prisma.user.findMany.mockResolvedValue([
        {
          id: "user-1",
          tenantId: "tenant-1",
          m2SafeAddress: "0x" + "a".repeat(40),
        },
      ]);

      publicClient.readContract.mockResolvedValue(50_000_000n); // 50 USDC

      const results = await sweepService.runSweepCycle();

      expect(results).toHaveLength(0);
      expect(walletClient.sendTransaction).not.toHaveBeenCalled();
    });

    it("creates audit log on successful sweep", async () => {
      prisma.user.findMany.mockResolvedValue([
        {
          id: "user-1",
          tenantId: "tenant-1",
          m2SafeAddress: "0x" + "a".repeat(40),
        },
      ]);

      publicClient.readContract.mockResolvedValue(200_000_000n);
      walletClient.sendTransaction.mockResolvedValue(
        ("0x" + "f".repeat(64)) as `0x${string}`,
      );
      publicClient.waitForTransactionReceipt.mockResolvedValue({
        status: "success",
        blockNumber: 999n,
        transactionHash: "0x" + "f".repeat(64),
      });

      await sweepService.runSweepCycle();

      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "sweep_executed",
            tenantId: "tenant-1",
          }),
        }),
      );
    });

    it("creates audit log on failed sweep", async () => {
      prisma.user.findMany.mockResolvedValue([
        {
          id: "user-1",
          tenantId: "tenant-1",
          m2SafeAddress: "0x" + "a".repeat(40),
        },
      ]);

      publicClient.readContract.mockResolvedValue(200_000_000n);
      walletClient.sendTransaction.mockRejectedValue(
        new Error("gas estimation failed"),
      );

      await sweepService.runSweepCycle();

      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "sweep_failed",
          }),
        }),
      );
    });
  });

  // ----------------------------------------------------------------
  // getSweepStatus
  // ----------------------------------------------------------------

  describe("getSweepStatus", () => {
    it("returns correct initial status", () => {
      const status = sweepService.getSweepStatus();

      expect(status.running).toBe(true);
      expect(status.lastRunAt).toBe(0);
      expect(status.lastRunSweepCount).toBe(0);
      expect(status.consecutiveFailures).toBe(0);
      expect(status.totalSweepsExecuted).toBe(0);
    });

    it("updates status after successful sweep cycle", async () => {
      prisma.user.findMany.mockResolvedValue([
        {
          id: "user-1",
          tenantId: "tenant-1",
          m2SafeAddress: "0x" + "a".repeat(40),
        },
      ]);

      publicClient.readContract.mockResolvedValue(200_000_000n);
      walletClient.sendTransaction.mockResolvedValue(
        ("0x" + "f".repeat(64)) as `0x${string}`,
      );
      publicClient.waitForTransactionReceipt.mockResolvedValue({
        status: "success",
        blockNumber: 999n,
        transactionHash: "0x" + "f".repeat(64),
      });

      await sweepService.runSweepCycle();

      const status = sweepService.getSweepStatus();
      expect(status.lastRunAt).toBeGreaterThan(0);
      expect(status.lastRunSweepCount).toBe(1);
      expect(status.totalSweepsExecuted).toBe(1);
    });
  });
});
