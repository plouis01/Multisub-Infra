import Redis from "ioredis";
import type { AuthorizationCache, CardMapping } from "../types/index.js";

// ============ Redis Key Schema ============
// auth:{eoaAddress}        → AuthorizationCache JSON
// card:{lithicCardToken}   → CardMapping JSON
// rate:{tenantId}:{window} → request count (sliding window)
// lock:{resource}          → distributed lock

const KEY_PREFIX = {
  AUTH: "auth:",
  CARD: "card:",
  RATE: "rate:",
  LOCK: "lock:",
} as const;

export function createRedisClient(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      if (times > 5) return null;
      return Math.min(times * 200, 2000);
    },
    lazyConnect: true,
  });
}

// ============ Authorization Cache ============

export async function getAuthCache(
  redis: Redis,
  eoaAddress: string,
): Promise<AuthorizationCache | null> {
  const raw = await redis.get(`${KEY_PREFIX.AUTH}${eoaAddress.toLowerCase()}`);
  if (!raw) return null;
  return JSON.parse(raw) as AuthorizationCache;
}

export async function setAuthCache(
  redis: Redis,
  eoaAddress: string,
  cache: AuthorizationCache,
  ttlSeconds = 300,
): Promise<void> {
  await redis.set(
    `${KEY_PREFIX.AUTH}${eoaAddress.toLowerCase()}`,
    JSON.stringify(cache),
    "EX",
    ttlSeconds,
  );
}

export async function updateAuthCacheSpend(
  redis: Redis,
  eoaAddress: string,
  amountCents: number,
): Promise<AuthorizationCache | null> {
  const key = `${KEY_PREFIX.AUTH}${eoaAddress.toLowerCase()}`;

  // Atomic read-modify-write via WATCH/MULTI/EXEC
  const result = await redis.watch(key).then(async () => {
    const raw = await redis.get(key);
    if (!raw) {
      await redis.unwatch();
      return null;
    }

    const cache = JSON.parse(raw) as AuthorizationCache;
    const newDailySpent = BigInt(cache.dailySpent) + BigInt(amountCents);
    const newMonthlySpent = BigInt(cache.monthlySpent) + BigInt(amountCents);
    const newBalance = BigInt(cache.usdcBalance) - BigInt(amountCents);

    cache.dailySpent = newDailySpent.toString();
    cache.monthlySpent = newMonthlySpent.toString();
    cache.usdcBalance = newBalance.toString();
    cache.lastUpdated = Date.now();

    const pipeline = redis.multi();
    pipeline.set(key, JSON.stringify(cache), "EX", 300);
    const execResult = await pipeline.exec();

    if (!execResult) return null; // Transaction failed (concurrent modification)
    return cache;
  });

  return result;
}

// ============ Card Mapping ============

export async function getCardMapping(
  redis: Redis,
  cardToken: string,
): Promise<CardMapping | null> {
  const raw = await redis.get(`${KEY_PREFIX.CARD}${cardToken}`);
  if (!raw) return null;
  return JSON.parse(raw) as CardMapping;
}

export async function setCardMapping(
  redis: Redis,
  cardToken: string,
  mapping: CardMapping,
): Promise<void> {
  await redis.set(`${KEY_PREFIX.CARD}${cardToken}`, JSON.stringify(mapping));
}

// ============ Rate Limiting ============

export async function checkRateLimit(
  redis: Redis,
  tenantId: string,
  limit: number,
  windowSeconds = 60,
): Promise<{ allowed: boolean; remaining: number }> {
  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / windowSeconds);
  const key = `${KEY_PREFIX.RATE}${tenantId}:${window}`;

  const current = await redis.incr(key);
  if (current === 1) {
    await redis.expire(key, windowSeconds + 1);
  }

  return {
    allowed: current <= limit,
    remaining: Math.max(0, limit - current),
  };
}
