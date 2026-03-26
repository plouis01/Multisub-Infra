import type { PublicClient } from "viem";
import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import type { Config } from "../config/index.js";
import { ERC20_ABI, SPEND_SETTLER_ABI } from "../lib/blockchain.js";
import { setAuthCache } from "../lib/redis.js";
import type { AuthorizationCache } from "../types/index.js";

// ============ Types ============

interface DepositEvent {
  from: string;
  to: string;
  amount: bigint;
  blockNumber: bigint;
  txHash: string;
  logIndex: number;
}

interface SpendSettledParsed {
  m2Safe: string;
  issuerSafe: string;
  amount: bigint;
  lithicTxToken: string;
  nonce: bigint;
  blockNumber: bigint;
  txHash: string;
  logIndex: number;
}

type OnDepositCallback = (deposit: DepositEvent) => void | Promise<void>;

// ============ Constants ============

const WATCHER_META_KEY_LAST_BLOCK = "watcher:lastProcessedBlock";
const CONFIRMATION_BUFFER = 2; // blocks behind head to account for reorgs
const MAX_CONSECUTIVE_FAILURES = 5;
const CIRCUIT_BREAKER_PAUSE_MS = 30_000;
const RECONCILIATION_INTERVAL_MS = 60_000; // 60s full balance reconciliation

// ============ Watcher Service ============

export class Watcher {
  private readonly config: Config;
  private readonly publicClient: PublicClient;
  private readonly prisma: PrismaClient;
  private readonly redis: Redis;
  private readonly onDeposit: OnDepositCallback;

  private pollIntervalMs: number;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private reconciliationTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveFailures = 0;
  private lastReconciliationAt = 0;

  /** Timestamp (ms) of the last successful poll — exposed for health checks. */
  public lastPollAt = 0;

  constructor(
    config: Config,
    publicClient: PublicClient,
    prisma: PrismaClient,
    redis: Redis,
    onDeposit: OnDepositCallback,
  ) {
    this.config = config;
    this.publicClient = publicClient;
    this.prisma = prisma;
    this.redis = redis;
    this.onDeposit = onDeposit;
    this.pollIntervalMs = config.watcherPollIntervalMs ?? 3000;
  }

  // ============ Lifecycle ============

  start(): void {
    if (this.running) {
      console.warn("[Watcher] already running — ignoring duplicate start()");
      return;
    }
    this.running = true;
    console.log(
      `[Watcher] starting — poll interval ${this.pollIntervalMs}ms, reconciliation every ${RECONCILIATION_INTERVAL_MS}ms`,
    );
    this.scheduleNextPoll(0); // first poll immediately
    this.scheduleReconciliation();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.reconciliationTimer) {
      clearTimeout(this.reconciliationTimer);
      this.reconciliationTimer = null;
    }
    console.log("[Watcher] stopped");
  }

  // ============ Poll loop ============

  private scheduleNextPoll(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.poll().catch((err) => {
        console.error("[Watcher] unhandled error in poll()", err);
      });
    }, delayMs);
  }

  private async poll(): Promise<void> {
    if (!this.running) return;

    try {
      const headBlock = await this.publicClient.getBlockNumber();
      const safeBlock = headBlock - BigInt(CONFIRMATION_BUFFER);

      if (safeBlock < 0n) {
        this.scheduleNextPoll(this.pollIntervalMs);
        return;
      }

      const fromBlock = await this.getLastProcessedBlock();

      // Nothing new to process
      if (fromBlock > safeBlock) {
        this.scheduleNextPoll(this.pollIntervalMs);
        return;
      }

      console.log(
        `[Watcher] polling blocks ${fromBlock}..${safeBlock} (head=${headBlock})`,
      );

      // Fetch and process events in parallel
      const [deposits, spendSettled] = await Promise.all([
        this.fetchDeposits(fromBlock, safeBlock),
        this.fetchSpendSettled(fromBlock, safeBlock),
      ]);

      // Persist SpendSettled events
      for (const evt of spendSettled) {
        await this.persistSpendSettled(evt);
      }

      // Handle deposits
      for (const dep of deposits) {
        await this.handleDeposit(dep);
      }

      // Update last processed block
      await this.setLastProcessedBlock(safeBlock);

      // Reset circuit breaker on success
      this.consecutiveFailures = 0;
      this.lastPollAt = Date.now();

      this.scheduleNextPoll(this.pollIntervalMs);
    } catch (err) {
      this.consecutiveFailures++;
      console.error(
        `[Watcher] poll error (${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
        err,
      );

      if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.warn(
          `[Watcher] circuit breaker tripped — pausing for ${CIRCUIT_BREAKER_PAUSE_MS}ms`,
        );
        this.consecutiveFailures = 0;
        this.scheduleNextPoll(CIRCUIT_BREAKER_PAUSE_MS);
      } else {
        this.scheduleNextPoll(this.pollIntervalMs);
      }
    }
  }

  // ============ Block tracking (WatcherMeta) ============

  private async getLastProcessedBlock(): Promise<bigint> {
    const meta = await this.prisma.watcherMeta.findUnique({
      where: { key: WATCHER_META_KEY_LAST_BLOCK },
    });

    if (meta) {
      return BigInt(meta.value) + 1n; // start from next unprocessed block
    }

    // First run — use configured start block
    const startBlock = BigInt(this.config.watcherStartBlock ?? 0);
    return startBlock;
  }

  private async setLastProcessedBlock(blockNumber: bigint): Promise<void> {
    await this.prisma.watcherMeta.upsert({
      where: { key: WATCHER_META_KEY_LAST_BLOCK },
      update: { value: blockNumber.toString() },
      create: {
        key: WATCHER_META_KEY_LAST_BLOCK,
        value: blockNumber.toString(),
      },
    });
  }

  // ============ USDC Transfer events (deposits to M2 safes) ============

  private async fetchDeposits(
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<DepositEvent[]> {
    // Fetch all USDC Transfer events in the block range
    const logs = await this.publicClient.getLogs({
      address: this.config.usdcAddress as `0x${string}`,
      event: {
        type: "event" as const,
        name: "Transfer",
        inputs: [
          { name: "from", type: "address", indexed: true },
          { name: "to", type: "address", indexed: true },
          { name: "value", type: "uint256", indexed: false },
        ],
      },
      fromBlock,
      toBlock,
    });

    // Filter for transfers TO known M2 safes
    const m2Safes = await this.getKnownM2Safes();
    const m2SafeSet = new Set(m2Safes.map((s) => s.toLowerCase()));

    const deposits: DepositEvent[] = [];
    for (const log of logs) {
      const to = (log.args.to as string).toLowerCase();
      if (m2SafeSet.has(to)) {
        deposits.push({
          from: log.args.from as string,
          to: log.args.to as string,
          amount: log.args.value as bigint,
          blockNumber: log.blockNumber,
          txHash: log.transactionHash,
          logIndex: log.logIndex,
        });
      }
    }

    if (deposits.length > 0) {
      console.log(
        `[Watcher] found ${deposits.length} deposit(s) in blocks ${fromBlock}..${toBlock}`,
      );
    }

    return deposits;
  }

  private async getKnownM2Safes(): Promise<string[]> {
    const users = await this.prisma.user.findMany({
      where: { m2SafeAddress: { not: null } },
      select: { m2SafeAddress: true },
    });
    return users
      .map((u: { m2SafeAddress: string | null }) => u.m2SafeAddress)
      .filter((addr: string | null): addr is string => addr !== null);
  }

  // ============ SpendSettled events ============

  private async fetchSpendSettled(
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<SpendSettledParsed[]> {
    if (!this.config.spendSettlerAddress) return [];

    const logs = await this.publicClient.getLogs({
      address: this.config.spendSettlerAddress as `0x${string}`,
      event: {
        type: "event" as const,
        name: "SpendSettled",
        inputs: [
          { name: "m2Safe", type: "address", indexed: true },
          { name: "issuerSafe", type: "address", indexed: true },
          { name: "amount", type: "uint256", indexed: false },
          { name: "lithicTxToken", type: "bytes32", indexed: true },
          { name: "nonce", type: "uint256", indexed: false },
        ],
      },
      fromBlock,
      toBlock,
    });

    const events: SpendSettledParsed[] = logs.map((log) => ({
      m2Safe: log.args.m2Safe as string,
      issuerSafe: log.args.issuerSafe as string,
      amount: log.args.amount as bigint,
      lithicTxToken: log.args.lithicTxToken as string,
      nonce: log.args.nonce as bigint,
      blockNumber: log.blockNumber,
      txHash: log.transactionHash,
      logIndex: log.logIndex,
    }));

    if (events.length > 0) {
      console.log(
        `[Watcher] found ${events.length} SpendSettled event(s) in blocks ${fromBlock}..${toBlock}`,
      );
    }

    return events;
  }

  // ============ Event persistence ============

  private async persistSpendSettled(evt: SpendSettledParsed): Promise<void> {
    try {
      await this.prisma.spendSettledEvent.upsert({
        where: { lithicTxToken: evt.lithicTxToken },
        update: {}, // idempotent — skip if already recorded
        create: {
          blockNumber: evt.blockNumber,
          txHash: evt.txHash,
          logIndex: evt.logIndex,
          m2Safe: evt.m2Safe,
          issuerSafe: evt.issuerSafe,
          amount: evt.amount.toString(),
          lithicTxToken: evt.lithicTxToken,
          nonce: evt.nonce,
        },
      });
    } catch (err) {
      console.error(
        `[Watcher] failed to persist SpendSettled event ${evt.lithicTxToken}`,
        err,
      );
    }
  }

  private async handleDeposit(deposit: DepositEvent): Promise<void> {
    try {
      // Find the user associated with this M2 safe
      const user = await this.prisma.user.findFirst({
        where: {
          m2SafeAddress: {
            equals: deposit.to,
            mode: "insensitive",
          },
        },
      });

      if (!user) {
        console.warn(
          `[Watcher] deposit to unknown M2 safe ${deposit.to} (tx: ${deposit.txHash})`,
        );
        return;
      }

      // Record in balance ledger
      await this.prisma.balanceLedger.create({
        data: {
          tenantId: user.tenantId,
          userId: user.id,
          token: "USDC",
          type: "deposit",
          amount: deposit.amount.toString(),
          reference: deposit.txHash,
          note: `Deposit from ${deposit.from}`,
        },
      });

      // Update Redis auth cache with new balance
      await this.updateRedisCacheForDeposit(user, deposit);

      // Fire callback
      await this.onDeposit(deposit);

      console.log(
        `[Watcher] processed deposit: ${deposit.amount} USDC to ${deposit.to} (user=${user.id})`,
      );
    } catch (err) {
      console.error(
        `[Watcher] failed to handle deposit (tx: ${deposit.txHash})`,
        err,
      );
    }
  }

  private async updateRedisCacheForDeposit(
    user: {
      id: string;
      tenantId: string;
      eoaAddress: string | null;
      m2SafeAddress: string | null;
    },
    deposit: DepositEvent,
  ): Promise<void> {
    if (!user.eoaAddress || !user.m2SafeAddress) return;

    try {
      // Fetch current on-chain USDC balance for the M2 safe
      const balance = (await this.publicClient.readContract({
        address: this.config.usdcAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [user.m2SafeAddress as `0x${string}`],
      })) as bigint;

      // Build a fresh cache entry (daily/monthly spend stay as-is from existing cache)
      const cache: AuthorizationCache = {
        eoaAddress: user.eoaAddress,
        m2SafeAddress: user.m2SafeAddress,
        tenantId: user.tenantId,
        usdcBalance: balance.toString(),
        dailySpent: "0",
        dailyLimit: "0",
        monthlySpent: "0",
        monthlyLimit: "0",
        lastUpdated: Date.now(),
      };

      await setAuthCache(this.redis, user.eoaAddress, cache);
    } catch (err) {
      console.error(
        `[Watcher] failed to update Redis cache for deposit to ${user.m2SafeAddress}`,
        err,
      );
    }
  }

  // ============ 60s Reconciliation ============
  // Full balance check: verify on-chain USDC balances match Redis cache

  private scheduleReconciliation(): void {
    if (!this.running) return;
    this.reconciliationTimer = setTimeout(() => {
      this.reconcile().catch((err) => {
        console.error("[Watcher] reconciliation error:", err);
      });
    }, RECONCILIATION_INTERVAL_MS);
  }

  private async reconcile(): Promise<void> {
    if (!this.running) return;

    try {
      const users = await this.prisma.user.findMany({
        where: {
          m2SafeAddress: { not: null },
          eoaAddress: { not: null },
          status: "active",
        },
        select: {
          id: true,
          tenantId: true,
          eoaAddress: true,
          m2SafeAddress: true,
        },
      });

      let reconciled = 0;
      for (const user of users) {
        if (!user.m2SafeAddress || !user.eoaAddress) continue;

        try {
          const onChainBalance = (await this.publicClient.readContract({
            address: this.config.usdcAddress as `0x${string}`,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [user.m2SafeAddress as `0x${string}`],
          })) as bigint;

          // Get existing cache to preserve spend tracking
          const { getAuthCache } = await import("../lib/redis.js");
          const existing = await getAuthCache(this.redis, user.eoaAddress);

          const cache: AuthorizationCache = {
            eoaAddress: user.eoaAddress,
            m2SafeAddress: user.m2SafeAddress,
            tenantId: user.tenantId,
            usdcBalance: onChainBalance.toString(),
            dailySpent: existing?.dailySpent ?? "0",
            dailyLimit: existing?.dailyLimit ?? "0",
            monthlySpent: existing?.monthlySpent ?? "0",
            monthlyLimit: existing?.monthlyLimit ?? "0",
            lastUpdated: Date.now(),
          };

          await setAuthCache(this.redis, user.eoaAddress, cache);
          reconciled++;
        } catch (err) {
          console.error(
            `[Watcher] reconciliation failed for user ${user.id} (safe=${user.m2SafeAddress})`,
            err,
          );
        }
      }

      this.lastReconciliationAt = Date.now();
      if (reconciled > 0) {
        console.log(
          `[Watcher] reconciliation complete — ${reconciled}/${users.length} users updated`,
        );
      }
    } finally {
      this.scheduleReconciliation();
    }
  }
}
