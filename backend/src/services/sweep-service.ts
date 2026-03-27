import { encodeFunctionData, type PublicClient, type WalletClient } from "viem";
import type { PrismaClient } from "@prisma/client";
import type { Config } from "../config/index.js";
import { ERC20_ABI } from "../lib/blockchain.js";

// ============ Constants ============

const LOG_PREFIX = "[Sweep]";
const MAX_CONSECUTIVE_FAILURES = 5;
const CIRCUIT_BREAKER_PAUSE_MS = 60_000;

// ============ Types ============

interface SweepResult {
  m2SafeAddress: string;
  userId: string;
  tenantId: string;
  amount: string;
  txHash: string;
}

export interface SweepStatus {
  running: boolean;
  lastRunAt: number;
  lastRunSweepCount: number;
  consecutiveFailures: number;
  totalSweepsExecuted: number;
}

// ============ Sweep Service ============

export class SweepService {
  private readonly config: Config;
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly prisma: PrismaClient;

  private readonly sweepThreshold: bigint;
  private readonly sweepIntervalMs: number;

  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveFailures = 0;
  private lastRunAt = 0;
  private lastRunSweepCount = 0;
  private totalSweepsExecuted = 0;

  constructor(
    config: Config,
    publicClient: PublicClient,
    walletClient: WalletClient,
    prisma: PrismaClient,
  ) {
    this.config = config;
    this.publicClient = publicClient;
    this.walletClient = walletClient;
    this.prisma = prisma;
    this.sweepThreshold = BigInt(config.sweepThreshold);
    this.sweepIntervalMs = config.sweepIntervalMs;
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
      `${LOG_PREFIX} starting -- interval ${this.sweepIntervalMs}ms, threshold ${this.sweepThreshold}`,
    );
    this.scheduleNext(0); // first run immediately
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    console.log(`${LOG_PREFIX} stopped`);
  }

  // ============ Scheduling ============

  private scheduleNext(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.runSweepCycle().catch((err) => {
        console.error(`${LOG_PREFIX} unhandled error in runSweepCycle()`, err);
      });
    }, delayMs);
  }

  // ============ Core Sweep Cycle ============

  async runSweepCycle(): Promise<SweepResult[]> {
    if (!this.running) return [];

    const results: SweepResult[] = [];

    try {
      // 1. Get all M2 Safes from active users in Model A tenants
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

      if (users.length === 0) {
        this.lastRunAt = Date.now();
        this.lastRunSweepCount = 0;
        this.consecutiveFailures = 0;
        this.scheduleNext(this.sweepIntervalMs);
        return [];
      }

      console.log(
        `${LOG_PREFIX} scanning ${users.length} M2 Safe(s) for sweepable balances`,
      );

      // 2. Check each M2 Safe balance
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

          // 3. Execute sweep: transfer USDC from M2 Safe to M1 Treasury
          console.log(
            `${LOG_PREFIX} sweeping ${balance} from ${user.m2SafeAddress} to M1 Treasury`,
          );

          const txHash = await this.executeSweep(user.m2SafeAddress, balance);

          const result: SweepResult = {
            m2SafeAddress: user.m2SafeAddress,
            userId: user.id,
            tenantId: user.tenantId,
            amount: balance.toString(),
            txHash,
          };
          results.push(result);

          // 4. Wait for confirmation
          const receipt = await this.publicClient.waitForTransactionReceipt({
            hash: txHash,
          });

          if (receipt.status === "success") {
            console.log(
              `${LOG_PREFIX} sweep confirmed: ${txHash} (block ${receipt.blockNumber})`,
            );

            // Record in balance ledger
            await this.recordSweep(user, balance, txHash);

            // Create audit log
            await this.createAuditLog(user.tenantId, "sweep_executed", {
              m2SafeAddress: user.m2SafeAddress,
              amount: balance.toString(),
              txHash,
              blockNumber: receipt.blockNumber.toString(),
            });
          } else {
            console.error(
              `${LOG_PREFIX} sweep tx reverted: ${txHash} for ${user.m2SafeAddress}`,
            );
            await this.createAuditLog(user.tenantId, "sweep_failed", {
              m2SafeAddress: user.m2SafeAddress,
              amount: balance.toString(),
              txHash,
              error: "Transaction reverted",
            });
          }
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          console.error(
            `${LOG_PREFIX} failed to sweep ${user.m2SafeAddress}: ${errorMessage}`,
          );
          await this.createAuditLog(user.tenantId, "sweep_failed", {
            m2SafeAddress: user.m2SafeAddress,
            error: errorMessage,
          });
        }
      }

      // Reset circuit breaker on success
      this.consecutiveFailures = 0;
      this.lastRunAt = Date.now();
      this.lastRunSweepCount = results.length;
      this.totalSweepsExecuted += results.length;

      if (results.length > 0) {
        console.log(
          `${LOG_PREFIX} cycle complete -- ${results.length} sweep(s) executed`,
        );
      }

      this.scheduleNext(this.sweepIntervalMs);
    } catch (err) {
      this.consecutiveFailures++;
      console.error(
        `${LOG_PREFIX} cycle error (${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
        err,
      );

      if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.warn(
          `${LOG_PREFIX} circuit breaker tripped -- pausing for ${CIRCUIT_BREAKER_PAUSE_MS}ms`,
        );
        this.consecutiveFailures = 0;
        this.scheduleNext(CIRCUIT_BREAKER_PAUSE_MS);
      } else {
        this.scheduleNext(this.sweepIntervalMs);
      }
    }

    return results;
  }

  // ============ On-chain Sweep Execution ============

  private async executeSweep(
    m2SafeAddress: string,
    amount: bigint,
  ): Promise<`0x${string}`> {
    // Encode USDC.transfer(m1Treasury, amount) calldata
    const transferData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [this.config.m1TreasuryAddress as `0x${string}`, amount],
    });

    // Execute through the Safe module (Sweeper role)
    // The wallet client acts as the Sweeper module attached to the M2 Safe
    const txHash = await this.walletClient.sendTransaction({
      to: m2SafeAddress as `0x${string}`,
      data: transferData,
      chain: this.walletClient.chain,
      account: this.walletClient.account!,
    });

    return txHash;
  }

  // ============ Database Operations ============

  private async recordSweep(
    user: { id: string; tenantId: string; m2SafeAddress: string | null },
    amount: bigint,
    txHash: string,
  ): Promise<void> {
    try {
      await this.prisma.balanceLedger.create({
        data: {
          tenantId: user.tenantId,
          userId: user.id,
          token: "USDC",
          type: "sweep",
          amount: amount.toString(),
          reference: txHash,
          note: `Sweep from M2 Safe ${user.m2SafeAddress} to M1 Treasury`,
        },
      });
    } catch (err) {
      console.error(
        `${LOG_PREFIX} failed to record sweep in balance ledger`,
        err,
      );
    }
  }

  private async createAuditLog(
    tenantId: string,
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

  // ============ Health Check ============

  getSweepStatus(): SweepStatus {
    return {
      running: this.running,
      lastRunAt: this.lastRunAt,
      lastRunSweepCount: this.lastRunSweepCount,
      consecutiveFailures: this.consecutiveFailures,
      totalSweepsExecuted: this.totalSweepsExecuted,
    };
  }
}
