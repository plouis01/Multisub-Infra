import type { Redis as RedisType } from "ioredis";
import type { PrismaClient } from "@prisma/client";
import {
  getAuthCache,
  getCardMapping,
  updateAuthCacheSpend,
  setAuthCache,
  setCardMapping,
} from "../lib/redis.js";
import type {
  AuthorizationRequest,
  AuthorizationResult,
  AuthorizationCache,
  CardMapping,
  LithicASAEvent,
} from "../types/index.js";

// ============ Constants ============

/** Maximum time allowed for the full authorization check (ms). */
const AUTH_TIMEOUT_MS = 300;

/** Default MCC blacklist: gambling, crypto, money orders, etc. */
const DEFAULT_MCC_BLACKLIST: ReadonlySet<string> = new Set([
  "7995", // Gambling
  "6051", // Crypto / quasi-cash
  "6211", // Security brokers (often used for crypto)
  "6012", // Financial institutions – merchandise/services
  "7801", // Government-licensed casinos
  "7802", // Government-licensed horse/dog racing
]);

/** Auth cache TTL when rebuilding from DB (seconds). */
const CACHE_TTL_SECONDS = 300;

/** Maximum WATCH/MULTI retries on optimistic lock contention. */
const MAX_ATOMIC_RETRIES = 3;

// ============ Error Types ============

export class AuthorizationTimeoutError extends Error {
  constructor(elapsedMs: number) {
    super(
      `Authorization exceeded ${AUTH_TIMEOUT_MS}ms deadline (took ${elapsedMs}ms)`,
    );
    this.name = "AuthorizationTimeoutError";
  }
}

export class AuthorizationError extends Error {
  constructor(
    message: string,
    public readonly step: string,
  ) {
    super(message);
    this.name = "AuthorizationError";
  }
}

// ============ Authorization Engine ============

export class AuthorizationEngine {
  private readonly redis: RedisType;
  private readonly prisma: PrismaClient;

  constructor(redis: RedisType, prisma: PrismaClient) {
    this.redis = redis;
    this.prisma = prisma;
  }

  /**
   * Main entry point: processes a Lithic ASA webhook event and returns
   * an approve/decline decision within the 300ms SLA.
   */
  async authorize(event: LithicASAEvent): Promise<AuthorizationResult> {
    const startTime = performance.now();

    try {
      // Only process AUTHORIZATION events; others are informational
      if (event.status !== "AUTHORIZATION") {
        return {
          approved: false,
          reason: `Non-authorization event: ${event.status}`,
        };
      }

      const amountCents = Math.abs(event.amount);
      if (amountCents <= 0) {
        return { approved: false, reason: "Invalid authorization amount" };
      }

      // ── Step 1: Card lookup ──
      const cardMapping = await this.lookupCard(event.card_token);
      if (!cardMapping) {
        return this.decline("Card not found", startTime);
      }
      this.checkDeadline(startTime, "card_lookup");

      // ── Step 2: Card status check ──
      if (cardMapping.status !== "active") {
        return this.decline(`Card is ${cardMapping.status}`, startTime);
      }
      this.checkDeadline(startTime, "card_status");

      // ── Step 3: KYC status check ──
      const kycApproved = await this.checkKycStatus(
        cardMapping.eoaAddress,
        cardMapping.tenantId,
      );
      if (!kycApproved) {
        return this.decline("KYC not approved", startTime);
      }
      this.checkDeadline(startTime, "kyc_check");

      // ── Step 4: Balance check ──
      let authCache = await this.getOrBuildAuthCache(cardMapping);
      if (!authCache) {
        return this.decline("Unable to load authorization cache", startTime);
      }
      this.checkDeadline(startTime, "balance_load");

      const currentBalance = BigInt(authCache.usdcBalance);
      if (currentBalance < BigInt(amountCents)) {
        return this.decline(
          `Insufficient balance: ${currentBalance} < ${amountCents}`,
          startTime,
        );
      }

      // ── Step 5: Daily limit check ──
      const dailySpent = BigInt(authCache.dailySpent);
      const dailyLimit = BigInt(authCache.dailyLimit);
      if (dailySpent + BigInt(amountCents) > dailyLimit) {
        return this.decline(
          `Daily limit exceeded: ${dailySpent} + ${amountCents} > ${dailyLimit}`,
          startTime,
        );
      }

      // ── Step 6: Monthly limit check ──
      const monthlySpent = BigInt(authCache.monthlySpent);
      const monthlyLimit = BigInt(authCache.monthlyLimit);
      if (monthlySpent + BigInt(amountCents) > monthlyLimit) {
        return this.decline(
          `Monthly limit exceeded: ${monthlySpent} + ${amountCents} > ${monthlyLimit}`,
          startTime,
        );
      }

      // ── Step 7: MCC filter check ──
      const mccBlocked = await this.checkMccBlacklist(
        event.merchant.mcc,
        cardMapping.subAccountId,
      );
      if (mccBlocked) {
        return this.decline(`Blocked MCC: ${event.merchant.mcc}`, startTime);
      }
      this.checkDeadline(startTime, "mcc_check");

      // ── Step 8: Optional on-chain verify (skip in fast path) ──
      // On-chain verification is deferred to async reconciliation to stay
      // within the 300ms SLA. A background job will compare on-chain balances
      // and flag discrepancies.

      // ── Step 9: Atomic Redis update ──
      const updatedCache = await this.atomicSpendUpdate(
        cardMapping.eoaAddress,
        amountCents,
      );
      if (!updatedCache) {
        return this.decline(
          "Concurrent modification — retry at network level",
          startTime,
        );
      }
      this.checkDeadline(startTime, "atomic_update");

      // ── Step 10: Approve ──
      const elapsed = performance.now() - startTime;
      await this.recordAuditLog(event, cardMapping, true, elapsed);

      return {
        approved: true,
        balanceAfter: updatedCache.usdcBalance,
      };
    } catch (error) {
      const elapsed = performance.now() - startTime;

      if (error instanceof AuthorizationTimeoutError) {
        // Decline on timeout — safety-first
        await this.recordAuditLog(
          event,
          null,
          false,
          elapsed,
          error.message,
        ).catch(() => {});
        return { approved: false, reason: "Authorization timeout" };
      }

      // Unexpected error — decline for safety, log for investigation
      const message = error instanceof Error ? error.message : "Unknown error";
      await this.recordAuditLog(event, null, false, elapsed, message).catch(
        () => {},
      );
      return { approved: false, reason: "Internal authorization error" };
    }
  }

  /**
   * Rebuilds the authorization cache for a given EOA address from the
   * database and (optionally) on-chain state. Called on cache miss or
   * when an admin triggers a manual refresh.
   */
  async refreshCache(eoaAddress: string): Promise<void> {
    const normalizedAddress = eoaAddress.toLowerCase();

    // Look up the user and their active sub-account
    const user = await this.prisma.user.findUnique({
      where: { eoaAddress: normalizedAddress },
      include: {
        subAccounts: {
          where: { status: "active" },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });

    if (!user) {
      throw new AuthorizationError(
        `User not found for EOA ${normalizedAddress}`,
        "refresh_cache",
      );
    }

    const subAccount = user.subAccounts[0];
    if (!subAccount) {
      throw new AuthorizationError(
        `No active sub-account for user ${user.id}`,
        "refresh_cache",
      );
    }

    // Compute daily and monthly spent from transactions
    const now = new Date();
    const startOfDay = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    );
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [dailyAgg, monthlyAgg, balanceLedgerAgg] = await Promise.all([
      this.prisma.transaction.aggregate({
        where: {
          userId: user.id,
          type: "authorization",
          status: { in: ["approved", "settled"] },
          createdAt: { gte: startOfDay },
        },
        _sum: { amount: true },
      }),
      this.prisma.transaction.aggregate({
        where: {
          userId: user.id,
          type: "authorization",
          status: { in: ["approved", "settled"] },
          createdAt: { gte: startOfMonth },
        },
        _sum: { amount: true },
      }),
      // Net USDC balance from ledger entries
      this.prisma.balanceLedger.findMany({
        where: { userId: user.id, token: "USDC" },
        select: { type: true, amount: true },
      }),
    ]);

    // Compute net balance from ledger (deposits add, spends/sweeps subtract)
    const creditTypes = new Set(["deposit", "refund", "yield"]);
    let netBalance = 0n;
    for (const entry of balanceLedgerAgg) {
      const entryAmount = BigInt(entry.amount);
      if (creditTypes.has(entry.type)) {
        netBalance += entryAmount;
      } else {
        netBalance -= entryAmount;
      }
    }
    if (netBalance < 0n) {
      netBalance = 0n;
    }

    const dailySpent = dailyAgg._sum.amount ?? 0n;
    const monthlySpent = monthlyAgg._sum.amount ?? 0n;

    const cache: AuthorizationCache = {
      eoaAddress: normalizedAddress,
      m2SafeAddress: user.m2SafeAddress ?? "",
      tenantId: user.tenantId,
      usdcBalance: netBalance.toString(),
      dailySpent: dailySpent.toString(),
      dailyLimit: subAccount.dailyLimit.toString(),
      monthlySpent: monthlySpent.toString(),
      monthlyLimit: subAccount.monthlyLimit.toString(),
      lastUpdated: Date.now(),
    };

    await setAuthCache(this.redis, normalizedAddress, cache, CACHE_TTL_SECONDS);

    // Also refresh card mapping if a Lithic card is linked
    if (subAccount.lithicCardToken) {
      const mapping: CardMapping = {
        subAccountId: subAccount.id,
        tenantId: user.tenantId,
        eoaAddress: normalizedAddress,
        m2SafeAddress: user.m2SafeAddress ?? "",
        status: subAccount.status as CardMapping["status"],
      };
      await setCardMapping(this.redis, subAccount.lithicCardToken, mapping);
    }
  }

  // ============ Private Helpers ============

  /**
   * Step 1: Lookup the card mapping from Redis.
   */
  private async lookupCard(cardToken: string): Promise<CardMapping | null> {
    return getCardMapping(this.redis, cardToken);
  }

  /**
   * Step 3: Check KYC status. First attempts the DB lookup directly since
   * KYC status is not stored in the auth cache.
   */
  private async checkKycStatus(
    eoaAddress: string,
    tenantId: string,
  ): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { eoaAddress: eoaAddress.toLowerCase() },
      select: { kycStatus: true },
    });

    return user?.kycStatus === "approved";
  }

  /**
   * Steps 4-6: Load the auth cache from Redis, falling back to a full
   * cache rebuild from the database if not present.
   */
  private async getOrBuildAuthCache(
    cardMapping: CardMapping,
  ): Promise<AuthorizationCache | null> {
    let cache = await getAuthCache(this.redis, cardMapping.eoaAddress);

    if (!cache) {
      // Cache miss — rebuild from database
      try {
        await this.refreshCache(cardMapping.eoaAddress);
        cache = await getAuthCache(this.redis, cardMapping.eoaAddress);
      } catch {
        return null;
      }
    }

    return cache;
  }

  /**
   * Step 7: Check whether the merchant's MCC code is blacklisted.
   * Checks both the global default blacklist and any per-card overrides.
   */
  private async checkMccBlacklist(
    mcc: string,
    subAccountId: string,
  ): Promise<boolean> {
    // Global blacklist
    if (DEFAULT_MCC_BLACKLIST.has(mcc)) {
      return true;
    }

    // Per-card blacklist from database
    const subAccount = await this.prisma.subAccount.findUnique({
      where: { id: subAccountId },
      select: { mccBlacklist: true },
    });

    if (subAccount?.mccBlacklist?.includes(mcc)) {
      return true;
    }

    return false;
  }

  /**
   * Step 9: Atomically update the authorization cache with the new spend.
   * Uses WATCH/MULTI/EXEC for optimistic locking. Retries on contention
   * up to MAX_ATOMIC_RETRIES times.
   */
  private async atomicSpendUpdate(
    eoaAddress: string,
    amountCents: number,
  ): Promise<AuthorizationCache | null> {
    for (let attempt = 0; attempt < MAX_ATOMIC_RETRIES; attempt++) {
      const result = await updateAuthCacheSpend(
        this.redis,
        eoaAddress,
        amountCents,
      );

      if (result !== null) {
        return result;
      }

      // Null means WATCH detected a concurrent modification.
      // Brief backoff before retry to reduce contention.
      if (attempt < MAX_ATOMIC_RETRIES - 1) {
        await new Promise((resolve) => setTimeout(resolve, 2 ** attempt));
      }
    }

    return null;
  }

  /**
   * Checks whether the authorization has exceeded the 300ms deadline.
   * Throws AuthorizationTimeoutError if so, causing a decline.
   */
  private checkDeadline(startTime: number, step: string): void {
    const elapsed = performance.now() - startTime;
    if (elapsed >= AUTH_TIMEOUT_MS) {
      throw new AuthorizationTimeoutError(Math.round(elapsed));
    }
  }

  /**
   * Constructs a decline result and fires an async audit log.
   */
  private decline(reason: string, startTime: number): AuthorizationResult {
    const elapsed = performance.now() - startTime;
    // Fire-and-forget audit log — do not block the response
    this.recordAuditLog(null, null, false, elapsed, reason).catch(() => {});
    return { approved: false, reason };
  }

  /**
   * Records an audit log entry for the authorization decision.
   * This is best-effort and must not block or fail the authorization flow.
   */
  private async recordAuditLog(
    event: LithicASAEvent | null,
    cardMapping: CardMapping | null,
    approved: boolean,
    elapsedMs: number,
    reason?: string,
  ): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          tenantId: cardMapping?.tenantId ?? null,
          action: approved ? "auth_approved" : "auth_declined",
          userId: null,
          details: {
            lithicTxToken: event?.token ?? null,
            cardToken: event?.card_token ?? null,
            amount: event?.amount ?? null,
            merchant: event?.merchant ?? null,
            approved,
            reason: reason ?? null,
            elapsedMs: Math.round(elapsedMs),
          },
        },
      });
    } catch {
      // Audit logging is best-effort; swallow errors to avoid
      // impacting authorization latency or availability.
    }
  }
}
