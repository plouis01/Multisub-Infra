import { Redis as IORedis } from "ioredis";

type RedisType = InstanceType<typeof IORedis>;
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

export function createRedisClient(url: string): RedisType {
  return new IORedis(url, {
    maxRetriesPerRequest: 3,
    retryStrategy(times: number) {
      if (times > 5) return null;
      return Math.min(times * 200, 2000);
    },
    lazyConnect: true,
  });
}

// ============ Authorization Cache ============

export async function getAuthCache(
  redis: RedisType,
  eoaAddress: string,
): Promise<AuthorizationCache | null> {
  const raw = await redis.get(`${KEY_PREFIX.AUTH}${eoaAddress.toLowerCase()}`);
  if (!raw) return null;
  return JSON.parse(raw) as AuthorizationCache;
}

export async function setAuthCache(
  redis: RedisType,
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
  redis: RedisType,
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

// ============ Atomic Spend (Lua Script) ============

const SPEND_LUA_SCRIPT = `
local key = KEYS[1]
local amountCents = tonumber(ARGV[1])
local raw = redis.call('GET', key)
if not raw then return nil end

local cache = cjson.decode(raw)
local balance = tonumber(cache.usdcBalance)
local dailySpent = tonumber(cache.dailySpent)
local monthlySpent = tonumber(cache.monthlySpent)
local dailyLimit = tonumber(cache.dailyLimit)
local monthlyLimit = tonumber(cache.monthlyLimit)

-- Check balance
if balance < amountCents then return cjson.encode({error = "insufficient_balance"}) end
-- Check daily limit
if dailyLimit > 0 and (dailySpent + amountCents) > dailyLimit then return cjson.encode({error = "daily_limit"}) end
-- Check monthly limit
if monthlyLimit > 0 and (monthlySpent + amountCents) > monthlyLimit then return cjson.encode({error = "monthly_limit"}) end

-- Update
cache.usdcBalance = tostring(balance - amountCents)
cache.dailySpent = tostring(dailySpent + amountCents)
cache.monthlySpent = tostring(monthlySpent + amountCents)
cache.lastUpdated = tonumber(ARGV[2])

local updated = cjson.encode(cache)
redis.call('SET', key, updated, 'EX', 300)
return updated
`;

export async function atomicAuthSpend(
  redis: RedisType,
  eoaAddress: string,
  amountCents: number,
): Promise<{ cache: AuthorizationCache | null; error?: string }> {
  const key = `${KEY_PREFIX.AUTH}${eoaAddress.toLowerCase()}`;
  const result = (await redis.eval(
    SPEND_LUA_SCRIPT,
    1,
    key,
    amountCents.toString(),
    Date.now().toString(),
  )) as string | null;

  if (!result) return { cache: null };

  const parsed = JSON.parse(result);
  if (parsed.error) return { cache: null, error: parsed.error };
  return { cache: parsed as AuthorizationCache };
}

// ============ Card Mapping ============

export async function getCardMapping(
  redis: RedisType,
  cardToken: string,
): Promise<CardMapping | null> {
  const raw = await redis.get(`${KEY_PREFIX.CARD}${cardToken}`);
  if (!raw) return null;
  return JSON.parse(raw) as CardMapping;
}

export async function setCardMapping(
  redis: RedisType,
  cardToken: string,
  mapping: CardMapping,
  ttlSeconds = 86400, // 24 hours
): Promise<void> {
  await redis.set(
    `${KEY_PREFIX.CARD}${cardToken}`,
    JSON.stringify(mapping),
    "EX",
    ttlSeconds,
  );
}

// ============ Rate Limiting ============

export async function checkRateLimit(
  redis: RedisType,
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
