import { encodeFunctionData, type PublicClient, type WalletClient } from "viem";
import type { PrismaClient } from "@prisma/client";
import { Queue, Worker, type Job } from "bullmq";
import type { Config } from "../config/index.js";
import { SPEND_SETTLER_ABI } from "../lib/blockchain.js";
import type { SettlementJob } from "../types/index.js";

// ============ Constants ============

const QUEUE_NAME = "settlement";
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_GAS_BUMP_PERCENT = 20;

// ============ Settlement Service ============

export class SettlementService {
  private readonly config: Config;
  private readonly walletClient: WalletClient;
  private readonly publicClient: PublicClient;
  private readonly prisma: PrismaClient;

  private readonly maxRetries: number;
  private readonly gasBumpPercent: number;

  private queue: Queue;
  private worker: Worker | null = null;
  private running = false;

  constructor(
    config: Config,
    walletClient: WalletClient,
    publicClient: PublicClient,
    prisma: PrismaClient,
  ) {
    this.config = config;
    this.walletClient = walletClient;
    this.publicClient = publicClient;
    this.prisma = prisma;
    this.maxRetries = config.settlementMaxRetries ?? DEFAULT_MAX_RETRIES;
    this.gasBumpPercent =
      config.settlementGasBumpPercent ?? DEFAULT_GAS_BUMP_PERCENT;

    this.queue = new Queue(QUEUE_NAME, {
      connection: { url: config.redisUrl },
    });
  }

  // ============ Lifecycle ============

  start(): void {
    if (this.running) {
      console.warn("[Settlement] already running — ignoring duplicate start()");
      return;
    }

    this.running = true;

    this.worker = new Worker(
      QUEUE_NAME,
      async (job: Job<SettlementJob>) => {
        await this.processJob(job.data);
      },
      {
        connection: { url: this.config.redisUrl },
        concurrency: 1, // process one settlement at a time to avoid nonce collisions
      },
    );

    this.worker.on("failed", (job, err) => {
      console.error(
        `[Settlement] worker job ${job?.id ?? "unknown"} failed:`,
        err.message,
      );
    });

    this.worker.on("completed", (job) => {
      console.log(`[Settlement] worker job ${job.id} completed`);
    });

    console.log("[Settlement] worker started");
  }

  stop(): void {
    this.running = false;
    if (this.worker) {
      this.worker
        .close()
        .catch((err) =>
          console.error("[Settlement] error closing worker", err),
        );
      this.worker = null;
    }
    this.queue
      .close()
      .catch((err) => console.error("[Settlement] error closing queue", err));
    console.log("[Settlement] stopped");
  }

  // ============ Enqueue ============

  async enqueue(job: SettlementJob): Promise<void> {
    await this.queue.add("settle", job, {
      jobId: `settle-${job.lithicTxToken}-${job.attempt}`,
      attempts: 1, // we handle retries ourselves for gas bumps
      removeOnComplete: 100,
      removeOnFail: 500,
    });
    console.log(
      `[Settlement] enqueued job for lithicTxToken=${job.lithicTxToken} attempt=${job.attempt}`,
    );
  }

  // ============ Batch processing (manual trigger) ============

  async processQueue(): Promise<void> {
    const waiting = await this.queue.getWaiting();
    console.log(
      `[Settlement] processQueue() — ${waiting.length} job(s) waiting`,
    );

    for (const job of waiting) {
      try {
        await this.processJob(job.data as SettlementJob);
        await job.remove();
      } catch (err) {
        console.error(
          `[Settlement] processQueue() error for job ${job.id}`,
          err,
        );
      }
    }
  }

  // ============ Core settlement logic ============

  private async processJob(job: SettlementJob): Promise<void> {
    const { lithicTxToken, m2SafeAddress, amount, attempt, tenantId } = job;

    console.log(
      `[Settlement] processing lithicTxToken=${lithicTxToken} amount=${amount} attempt=${attempt}`,
    );

    try {
      // 1. Idempotency check — skip if already settled on-chain
      const alreadySettled = await this.checkIfSettled(lithicTxToken);
      if (alreadySettled) {
        console.log(
          `[Settlement] lithicTxToken=${lithicTxToken} already settled on-chain — skipping`,
        );
        await this.markTransactionSettled(lithicTxToken, null);
        return;
      }

      // 2. Estimate gas, apply gas bump for retries
      const gasEstimate = await this.estimateGas(job);
      const bumpedGas = this.applyGasBump(gasEstimate, attempt);

      // 3. Submit on-chain transaction
      const txHash = await this.submitSettlement(job, bumpedGas);

      console.log(
        `[Settlement] tx submitted: ${txHash} for lithicTxToken=${lithicTxToken}`,
      );

      // 4. Wait for confirmation
      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash: txHash,
      });

      if (receipt.status === "success") {
        console.log(
          `[Settlement] confirmed: ${txHash} (block ${receipt.blockNumber})`,
        );
        await this.markTransactionSettled(lithicTxToken, txHash);
        await this.createAuditLog(tenantId, "settlement_executed", {
          lithicTxToken,
          txHash,
          amount,
          m2SafeAddress,
          attempt,
          blockNumber: receipt.blockNumber.toString(),
        });
      } else {
        throw new Error(`Transaction reverted: ${txHash}`);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error(
        `[Settlement] attempt ${attempt} failed for ${lithicTxToken}: ${errorMessage}`,
      );

      if (attempt < this.maxRetries) {
        // Retry with gas bump
        const retryJob: SettlementJob = {
          ...job,
          attempt: attempt + 1,
        };
        await this.enqueue(retryJob);
        await this.updateTransactionRetry(lithicTxToken, attempt, errorMessage);
      } else {
        // Max retries exhausted — mark as failed
        console.error(
          `[Settlement] max retries (${this.maxRetries}) exhausted for ${lithicTxToken}`,
        );
        await this.markTransactionFailed(lithicTxToken, errorMessage);
        await this.createAuditLog(tenantId, "settlement_failed", {
          lithicTxToken,
          amount,
          m2SafeAddress,
          attempt,
          error: errorMessage,
        });
      }
    }
  }

  // ============ On-chain interactions ============

  private async checkIfSettled(lithicTxToken: string): Promise<boolean> {
    try {
      const result = await this.publicClient.readContract({
        address: this.config.spendSettlerAddress as `0x${string}`,
        abi: SPEND_SETTLER_ABI,
        functionName: "isSettled",
        args: [lithicTxToken as `0x${string}`],
      });
      return result as boolean;
    } catch (err) {
      console.error(
        `[Settlement] isSettled() check failed for ${lithicTxToken}`,
        err,
      );
      return false;
    }
  }

  private async estimateGas(job: SettlementJob): Promise<bigint> {
    try {
      const gas = await this.publicClient.estimateGas({
        account: this.walletClient.account!,
        to: this.config.spendSettlerAddress as `0x${string}`,
        data: this.encodeSettleCalldata(job),
      });
      return gas;
    } catch {
      // Fallback gas estimate if estimation fails
      return 200_000n;
    }
  }

  private encodeSettleCalldata(job: SettlementJob): `0x${string}` {
    return encodeFunctionData({
      abi: SPEND_SETTLER_ABI,
      functionName: "settle",
      args: [BigInt(job.amount), job.lithicTxToken as `0x${string}`],
    });
  }

  private applyGasBump(baseGas: bigint, attempt: number): bigint {
    if (attempt <= 1) return baseGas;
    const bumpMultiplier = 100 + this.gasBumpPercent * (attempt - 1);
    return (baseGas * BigInt(bumpMultiplier)) / 100n;
  }

  private async submitSettlement(
    job: SettlementJob,
    gasLimit: bigint,
  ): Promise<`0x${string}`> {
    const txHash = await this.walletClient.writeContract({
      address: this.config.spendSettlerAddress as `0x${string}`,
      abi: SPEND_SETTLER_ABI,
      functionName: "settle",
      args: [BigInt(job.amount), job.lithicTxToken as `0x${string}`],
      gas: gasLimit,
      chain: this.walletClient.chain,
      account: this.walletClient.account!,
    });

    return txHash;
  }

  // ============ Database updates ============

  private async markTransactionSettled(
    lithicTxToken: string,
    txHash: string | null,
  ): Promise<void> {
    try {
      await this.prisma.transaction.update({
        where: { lithicTxToken },
        data: {
          status: "settled",
          ...(txHash ? { onChainTxHash: txHash } : {}),
        },
      });
    } catch (err) {
      console.error(
        `[Settlement] failed to mark transaction ${lithicTxToken} as settled`,
        err,
      );
    }
  }

  private async markTransactionFailed(
    lithicTxToken: string,
    errorMessage: string,
  ): Promise<void> {
    try {
      await this.prisma.transaction.update({
        where: { lithicTxToken },
        data: {
          status: "failed",
          errorMessage,
        },
      });
    } catch (err) {
      console.error(
        `[Settlement] failed to mark transaction ${lithicTxToken} as failed`,
        err,
      );
    }
  }

  private async updateTransactionRetry(
    lithicTxToken: string,
    attempt: number,
    errorMessage: string,
  ): Promise<void> {
    try {
      await this.prisma.transaction.update({
        where: { lithicTxToken },
        data: {
          retryCount: attempt,
          errorMessage,
        },
      });
    } catch (err) {
      console.error(
        `[Settlement] failed to update retry count for ${lithicTxToken}`,
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
      console.error(`[Settlement] failed to create audit log: ${action}`, err);
    }
  }
}
