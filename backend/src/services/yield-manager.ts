import {
  encodeFunctionData,
  parseAbi,
  type PublicClient,
  type WalletClient,
} from "viem";
import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import type { Config } from "../config/index.js";
import { ERC20_ABI } from "../lib/blockchain.js";

// ============ ABI Constants ============

export const MORPHO_VAULT_ABI = parseAbi([
  "function convertToAssets(uint256 shares) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
]);

export const TREASURY_VAULT_ABI = parseAbi([
  "function getTenantPosition(bytes32 tenantId) external view returns (uint256 deposited, uint256 shares, uint256 lastDepositTimestamp)",
]);

// ============ Constants ============

const LOG_PREFIX = "[YieldManager]";
const MAX_CONSECUTIVE_FAILURES = 5;
const CIRCUIT_BREAKER_PAUSE_MS = 60_000;
const ISSUER_SAFE_MIN_BALANCE = 10_000_000_000n; // 10,000 USDC (6-decimal)
const ISSUER_SAFE_TOPUP_AMOUNT = 50_000_000_000n; // 50,000 USDC top-up target

// Yield allocation splits (must sum to 10_000 = 100%)
export const ALLOCATION_PLATFORM_BPS = 3000; // 30% to Platform Issuer
export const ALLOCATION_TENANT_BPS = 6000; // 60% to tenant yield accrual
export const ALLOCATION_RESERVE_BPS = 1000; // 10% reserve (stays in vault)

const ALLOCATION_MIN_YIELD = 1_000_000n; // $1 USDC in 6-decimal -- skip dust

// ============ Types ============

export interface YieldSummary {
  totalDeposited: string;
  totalShares: string;
  currentValue: string;
  unrealizedYield: string;
  apyBps: number;
}

interface SnapshotResult {
  tenantId: string;
  totalDeposited: string;
  totalShares: string;
  totalYield: string;
  apyBps: number;
}

export interface AllocationResult {
  tenantId: string;
  totalYield: string;
  platformShare: string;
  tenantShare: string;
  reserveShare: string;
  txHash: string | null;
}

// ============ Yield Manager ============

export class YieldManager {
  private readonly config: Config;
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly prisma: PrismaClient;
  private readonly redis: Redis;

  private readonly sweepIntervalMs: number;
  private readonly snapshotIntervalMs: number;
  private readonly sweepThreshold: bigint;

  private running = false;
  private sweepTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private topUpTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveFailures = 0;

  /** Timestamps exposed for health checks */
  public lastSweepAt = 0;
  public lastSnapshotAt = 0;
  public lastTopUpCheckAt = 0;
  public lastAllocationAt = 0;

  constructor(
    config: Config,
    publicClient: PublicClient,
    walletClient: WalletClient,
    prisma: PrismaClient,
    redis: Redis,
  ) {
    this.config = config;
    this.publicClient = publicClient;
    this.walletClient = walletClient;
    this.prisma = prisma;
    this.redis = redis;
    this.sweepIntervalMs = config.sweepIntervalMs;
    this.snapshotIntervalMs = config.yieldSnapshotIntervalMs;
    this.sweepThreshold = BigInt(config.sweepThreshold);
  }

  // ============ Lifecycle ============

  start(): void {
    if (this.running) {
      console.warn(
        `${LOG_PREFIX} already running -- ignoring duplicate start()`,
      );
      return;
    }
    this.running = true;
    console.log(
      `${LOG_PREFIX} starting -- sweep every ${this.sweepIntervalMs}ms, snapshot every ${this.snapshotIntervalMs}ms`,
    );

    // Schedule sweep (first run after short delay to let other services warm up)
    this.scheduleSweep(5_000);
    // Schedule yield snapshot
    this.scheduleSnapshot(10_000);
    // Schedule issuer safe top-up check (runs alongside sweep)
    this.scheduleTopUpCheck(15_000);
  }

  stop(): void {
    this.running = false;
    if (this.sweepTimer) {
      clearTimeout(this.sweepTimer);
      this.sweepTimer = null;
    }
    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    if (this.topUpTimer) {
      clearTimeout(this.topUpTimer);
      this.topUpTimer = null;
    }
    console.log(`${LOG_PREFIX} stopped`);
  }

  // ============ Scheduling ============

  private scheduleSweep(delayMs: number): void {
    if (!this.running) return;
    this.sweepTimer = setTimeout(() => {
      this.sweep().catch((err) => {
        console.error(`${LOG_PREFIX} unhandled error in sweep()`, err);
      });
    }, delayMs);
  }

  private scheduleSnapshot(delayMs: number): void {
    if (!this.running) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotYield()
        .then((snapshots) => {
          if (snapshots.length > 0) {
            return this.allocateYield(snapshots);
          }
          return [];
        })
        .catch((err) => {
          console.error(
            `${LOG_PREFIX} unhandled error in snapshotYield/allocateYield`,
            err,
          );
        });
    }, delayMs);
  }

  private scheduleTopUpCheck(delayMs: number): void {
    if (!this.running) return;
    this.topUpTimer = setTimeout(() => {
      this.topUpIssuerSafe().catch((err) => {
        console.error(
          `${LOG_PREFIX} unhandled error in topUpIssuerSafe()`,
          err,
        );
      });
    }, delayMs);
  }

  // ============ Sweep: M2 Safes -> M1 Treasury ============

  async sweep(): Promise<number> {
    if (!this.running) return 0;

    let sweepCount = 0;

    try {
      // Get all M2 Safes from active Model A users
      const users = await this.prisma.user.findMany({
        where: {
          m2SafeAddress: { not: null },
          status: "active",
          tenant: {
            custodyModel: "MODEL_A",
            status: "active",
          },
        },
        select: {
          id: true,
          tenantId: true,
          m2SafeAddress: true,
        },
      });

      if (users.length > 0) {
        console.log(`${LOG_PREFIX} sweep: scanning ${users.length} M2 Safe(s)`);
      }

      for (const user of users) {
        if (!user.m2SafeAddress) continue;

        try {
          const balance = (await this.publicClient.readContract({
            address: this.config.usdcAddress as `0x${string}`,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [user.m2SafeAddress as `0x${string}`],
          })) as bigint;

          if (balance <= this.sweepThreshold) continue;

          console.log(
            `${LOG_PREFIX} sweep: ${user.m2SafeAddress} has ${balance} (threshold ${this.sweepThreshold})`,
          );

          // Execute USDC.transfer from M2 Safe to M1 Treasury
          const transferData = encodeFunctionData({
            abi: ERC20_ABI,
            functionName: "transfer",
            args: [this.config.m1TreasuryAddress as `0x${string}`, balance],
          });

          const txHash = await this.walletClient.sendTransaction({
            to: user.m2SafeAddress as `0x${string}`,
            data: transferData,
            chain: this.walletClient.chain,
            account: this.walletClient.account!,
          });

          const receipt = await this.publicClient.waitForTransactionReceipt({
            hash: txHash,
          });

          if (receipt.status === "success") {
            sweepCount++;
            console.log(
              `${LOG_PREFIX} sweep confirmed: ${txHash} (block ${receipt.blockNumber})`,
            );

            await this.prisma.balanceLedger.create({
              data: {
                tenantId: user.tenantId,
                userId: user.id,
                token: "USDC",
                type: "sweep",
                amount: balance.toString(),
                reference: txHash,
                note: `Sweep M2 ${user.m2SafeAddress} -> M1 Treasury`,
              },
            });

            await this.createAuditLog(user.tenantId, "sweep_executed", {
              m2SafeAddress: user.m2SafeAddress,
              amount: balance.toString(),
              txHash,
              blockNumber: receipt.blockNumber.toString(),
            });
          } else {
            console.error(`${LOG_PREFIX} sweep tx reverted: ${txHash}`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(
            `${LOG_PREFIX} sweep error for ${user.m2SafeAddress}: ${msg}`,
          );
        }
      }

      this.consecutiveFailures = 0;
      this.lastSweepAt = Date.now();
      this.scheduleSweep(this.sweepIntervalMs);
    } catch (err) {
      this.consecutiveFailures++;
      console.error(
        `${LOG_PREFIX} sweep cycle error (${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
        err,
      );

      if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.warn(
          `${LOG_PREFIX} circuit breaker tripped -- pausing sweep for ${CIRCUIT_BREAKER_PAUSE_MS}ms`,
        );
        this.consecutiveFailures = 0;
        this.scheduleSweep(CIRCUIT_BREAKER_PAUSE_MS);
      } else {
        this.scheduleSweep(this.sweepIntervalMs);
      }
    }

    return sweepCount;
  }

  // ============ Yield Snapshot ============

  async snapshotYield(): Promise<SnapshotResult[]> {
    if (!this.running) return [];

    const results: SnapshotResult[] = [];

    try {
      if (
        !this.config.morphoVaultAddress ||
        !this.config.treasuryVaultAddress
      ) {
        console.log(
          `${LOG_PREFIX} snapshot: vault addresses not configured -- skipping`,
        );
        this.lastSnapshotAt = Date.now();
        this.scheduleSnapshot(this.snapshotIntervalMs);
        return [];
      }

      // Get all active tenants
      const tenants = await this.prisma.tenant.findMany({
        where: { status: "active" },
        select: { id: true, name: true },
      });

      console.log(
        `${LOG_PREFIX} snapshot: computing yield for ${tenants.length} tenant(s)`,
      );

      const snapshotDate = new Date();

      for (const tenant of tenants) {
        try {
          // Read tenant position from TreasuryVault
          const tenantIdBytes = this.toBytes32(tenant.id);

          const position = (await this.publicClient.readContract({
            address: this.config.treasuryVaultAddress as `0x${string}`,
            abi: TREASURY_VAULT_ABI,
            functionName: "getTenantPosition",
            args: [tenantIdBytes],
          })) as [bigint, bigint, bigint];

          const [deposited, shares, _lastDepositTimestamp] = position;

          if (shares === 0n) continue; // No position for this tenant

          // Convert shares to current asset value via Morpho vault
          const currentValue = (await this.publicClient.readContract({
            address: this.config.morphoVaultAddress as `0x${string}`,
            abi: MORPHO_VAULT_ABI,
            functionName: "convertToAssets",
            args: [shares],
          })) as bigint;

          // Calculate unrealized yield
          const unrealizedYield =
            currentValue > deposited ? currentValue - deposited : 0n;

          // Calculate APY in basis points
          // APY (bps) = (yield / deposited) * 10000
          const apyBps =
            deposited > 0n
              ? Number((unrealizedYield * 10_000n) / deposited)
              : 0;

          // Record snapshot in YieldLedger
          await this.prisma.yieldLedger.create({
            data: {
              tenantId: tenant.id,
              snapshotDate,
              totalDeposited: deposited.toString(),
              totalShares: shares.toString(),
              totalYield: unrealizedYield.toString(),
              apyBps,
            },
          });

          const result: SnapshotResult = {
            tenantId: tenant.id,
            totalDeposited: deposited.toString(),
            totalShares: shares.toString(),
            totalYield: unrealizedYield.toString(),
            apyBps,
          };
          results.push(result);

          console.log(
            `${LOG_PREFIX} snapshot: tenant=${tenant.name} deposited=${deposited} value=${currentValue} yield=${unrealizedYield} apy=${apyBps}bps`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(
            `${LOG_PREFIX} snapshot error for tenant ${tenant.id}: ${msg}`,
          );
        }
      }

      this.lastSnapshotAt = Date.now();
      console.log(
        `${LOG_PREFIX} snapshot complete -- ${results.length} tenant(s) recorded`,
      );

      this.scheduleSnapshot(this.snapshotIntervalMs);
    } catch (err) {
      console.error(`${LOG_PREFIX} snapshot cycle error`, err);
      this.scheduleSnapshot(this.snapshotIntervalMs);
    }

    return results;
  }

  // ============ Yield Allocation (60/30/10) ============

  async allocateYield(
    snapshots: SnapshotResult[],
  ): Promise<AllocationResult[]> {
    if (!this.running) return [];

    const results: AllocationResult[] = [];

    try {
      if (
        !this.config.platformIssuerSafeAddress ||
        !this.config.m1TreasuryAddress
      ) {
        console.log(
          `${LOG_PREFIX} allocate: issuer/treasury addresses not configured -- skipping`,
        );
        this.lastAllocationAt = Date.now();
        return [];
      }

      // Filter to tenants with yield above the minimum threshold ($1)
      const eligible = snapshots.filter(
        (s) => BigInt(s.totalYield) >= ALLOCATION_MIN_YIELD,
      );

      if (eligible.length === 0) {
        console.log(
          `${LOG_PREFIX} allocate: no tenants with yield above minimum ($1) -- skipping`,
        );
        this.lastAllocationAt = Date.now();
        return [];
      }

      console.log(
        `${LOG_PREFIX} allocate: distributing yield for ${eligible.length} tenant(s)`,
      );

      for (const snapshot of eligible) {
        try {
          const totalYield = BigInt(snapshot.totalYield);

          // Split according to 60/30/10 basis points
          const platformShare =
            (totalYield * BigInt(ALLOCATION_PLATFORM_BPS)) / 10_000n;
          const tenantShare =
            (totalYield * BigInt(ALLOCATION_TENANT_BPS)) / 10_000n;
          const reserveShare = totalYield - platformShare - tenantShare;

          // --- Transfer platform share from M1 Treasury to Platform Issuer Safe ---
          const transferData = encodeFunctionData({
            abi: ERC20_ABI,
            functionName: "transfer",
            args: [
              this.config.platformIssuerSafeAddress as `0x${string}`,
              platformShare,
            ],
          });

          const txHash = await this.walletClient.sendTransaction({
            to: this.config.m1TreasuryAddress as `0x${string}`,
            data: transferData,
            chain: this.walletClient.chain,
            account: this.walletClient.account!,
          });

          const receipt = await this.publicClient.waitForTransactionReceipt({
            hash: txHash,
          });

          if (receipt.status !== "success") {
            console.error(
              `${LOG_PREFIX} allocate: platform transfer reverted for tenant ${snapshot.tenantId}: ${txHash}`,
            );
            continue;
          }

          console.log(
            `${LOG_PREFIX} allocate: tenant=${snapshot.tenantId} platform=${platformShare} tenant=${tenantShare} reserve=${reserveShare} tx=${txHash}`,
          );

          // --- Credit tenant share to BalanceLedger ---
          // Find first active user for this tenant to satisfy the userId FK
          const tenantUsers = await this.prisma.user.findMany({
            where: { tenantId: snapshot.tenantId, status: "active" },
            select: { id: true },
            take: 1,
          });

          if (tenantUsers.length > 0) {
            await this.prisma.balanceLedger.create({
              data: {
                tenantId: snapshot.tenantId,
                userId: tenantUsers[0].id,
                token: "USDC",
                type: "yield",
                amount: tenantShare.toString(),
                reference: txHash,
                note: `Yield allocation (60%) for tenant ${snapshot.tenantId}`,
              },
            });
          }

          // --- Record platform share in BalanceLedger ---
          if (tenantUsers.length > 0) {
            await this.prisma.balanceLedger.create({
              data: {
                tenantId: snapshot.tenantId,
                userId: tenantUsers[0].id,
                token: "USDC",
                type: "yield",
                amount: platformShare.toString(),
                reference: txHash,
                note: `Yield allocation (30%) platform share -> Issuer Safe`,
              },
            });
          }

          // --- Audit log ---
          await this.createAuditLog(snapshot.tenantId, "yield_allocated", {
            totalYield: totalYield.toString(),
            platformShare: platformShare.toString(),
            tenantShare: tenantShare.toString(),
            reserveShare: reserveShare.toString(),
            txHash,
            blockNumber: receipt.blockNumber.toString(),
          });

          results.push({
            tenantId: snapshot.tenantId,
            totalYield: totalYield.toString(),
            platformShare: platformShare.toString(),
            tenantShare: tenantShare.toString(),
            reserveShare: reserveShare.toString(),
            txHash,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(
            `${LOG_PREFIX} allocate error for tenant ${snapshot.tenantId}: ${msg}`,
          );
        }
      }

      this.lastAllocationAt = Date.now();
      console.log(
        `${LOG_PREFIX} allocate complete -- ${results.length} tenant(s) allocated`,
      );
    } catch (err) {
      console.error(`${LOG_PREFIX} allocate cycle error`, err);
    }

    return results;
  }

  // ============ Issuer Safe Top-Up ============

  async topUpIssuerSafe(): Promise<boolean> {
    if (!this.running) return false;

    let topped = false;

    try {
      if (
        !this.config.platformIssuerSafeAddress ||
        !this.config.m1TreasuryAddress
      ) {
        this.lastTopUpCheckAt = Date.now();
        this.scheduleTopUpCheck(this.sweepIntervalMs);
        return false;
      }

      // Check Platform Issuer Safe USDC balance
      const issuerBalance = (await this.publicClient.readContract({
        address: this.config.usdcAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [this.config.platformIssuerSafeAddress as `0x${string}`],
      })) as bigint;

      if (issuerBalance < ISSUER_SAFE_MIN_BALANCE) {
        console.log(
          `${LOG_PREFIX} issuer safe balance ${issuerBalance} below minimum ${ISSUER_SAFE_MIN_BALANCE} -- initiating top-up`,
        );

        // Calculate top-up amount to reach target
        const topUpAmount = ISSUER_SAFE_TOPUP_AMOUNT - issuerBalance;

        // Check M1 Treasury has enough funds
        const treasuryBalance = (await this.publicClient.readContract({
          address: this.config.usdcAddress as `0x${string}`,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [this.config.m1TreasuryAddress as `0x${string}`],
        })) as bigint;

        if (treasuryBalance < topUpAmount) {
          console.warn(
            `${LOG_PREFIX} M1 Treasury balance ${treasuryBalance} insufficient for top-up of ${topUpAmount}`,
          );
          this.lastTopUpCheckAt = Date.now();
          this.scheduleTopUpCheck(this.sweepIntervalMs);
          return false;
        }

        // Execute transfer from M1 Treasury to Issuer Safe
        const transferData = encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "transfer",
          args: [
            this.config.platformIssuerSafeAddress as `0x${string}`,
            topUpAmount,
          ],
        });

        const txHash = await this.walletClient.sendTransaction({
          to: this.config.m1TreasuryAddress as `0x${string}`,
          data: transferData,
          chain: this.walletClient.chain,
          account: this.walletClient.account!,
        });

        const receipt = await this.publicClient.waitForTransactionReceipt({
          hash: txHash,
        });

        if (receipt.status === "success") {
          topped = true;
          console.log(
            `${LOG_PREFIX} issuer safe topped up: ${topUpAmount} USDC (tx: ${txHash})`,
          );

          await this.createAuditLog(null, "issuer_safe_topup", {
            amount: topUpAmount.toString(),
            issuerSafe: this.config.platformIssuerSafeAddress,
            txHash,
            blockNumber: receipt.blockNumber.toString(),
          });
        } else {
          console.error(
            `${LOG_PREFIX} issuer safe top-up tx reverted: ${txHash}`,
          );
        }
      }

      this.lastTopUpCheckAt = Date.now();
      this.scheduleTopUpCheck(this.sweepIntervalMs);
    } catch (err) {
      console.error(`${LOG_PREFIX} top-up check error`, err);
      this.scheduleTopUpCheck(this.sweepIntervalMs);
    }

    return topped;
  }

  // ============ Query: Yield Summary ============

  async getYieldSummary(tenantId: string): Promise<YieldSummary | null> {
    if (!this.config.morphoVaultAddress || !this.config.treasuryVaultAddress) {
      return null;
    }

    try {
      const tenantIdBytes = this.toBytes32(tenantId);

      // Read current position from TreasuryVault
      const position = (await this.publicClient.readContract({
        address: this.config.treasuryVaultAddress as `0x${string}`,
        abi: TREASURY_VAULT_ABI,
        functionName: "getTenantPosition",
        args: [tenantIdBytes],
      })) as [bigint, bigint, bigint];

      const [deposited, shares] = position;

      if (shares === 0n) {
        return {
          totalDeposited: "0",
          totalShares: "0",
          currentValue: "0",
          unrealizedYield: "0",
          apyBps: 0,
        };
      }

      // Get current value of shares
      const currentValue = (await this.publicClient.readContract({
        address: this.config.morphoVaultAddress as `0x${string}`,
        abi: MORPHO_VAULT_ABI,
        functionName: "convertToAssets",
        args: [shares],
      })) as bigint;

      const unrealizedYield =
        currentValue > deposited ? currentValue - deposited : 0n;

      const apyBps =
        deposited > 0n ? Number((unrealizedYield * 10_000n) / deposited) : 0;

      return {
        totalDeposited: deposited.toString(),
        totalShares: shares.toString(),
        currentValue: currentValue.toString(),
        unrealizedYield: unrealizedYield.toString(),
        apyBps,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `${LOG_PREFIX} getYieldSummary error for tenant ${tenantId}: ${msg}`,
      );
      return null;
    }
  }

  // ============ Helpers ============

  private toBytes32(value: string): `0x${string}` {
    // Encode a string as bytes32 (left-padded with zeros, truncated to 32 bytes)
    const hex = Buffer.from(value).toString("hex").padEnd(64, "0").slice(0, 64);
    return `0x${hex}`;
  }

  private async createAuditLog(
    tenantId: string | null,
    action: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          tenantId,
          action,
          details: details as object,
        },
      });
    } catch (err) {
      console.error(`${LOG_PREFIX} failed to create audit log: ${action}`, err);
    }
  }
}
