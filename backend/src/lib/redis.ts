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
): Promise<{ cache: AuthorizationCache | null; error?: string }> {
  const key = `${KEY_PREFIX.AUTH}${eoaAddress.toLowerCase()}`;

  // Atomic read-validate-write via WATCH/MULTI/EXEC
  // Mirrors the Lua script checks: balance, daily limit, monthly limit
  const result = await redis.watch(key).then(async () => {
    const raw = await redis.get(key);
    if (!raw) {
      await redis.unwatch();
      return { cache: null };
    }

    const cache = JSON.parse(raw) as AuthorizationCache;
    const balance = BigInt(cache.usdcBalance);
    const dailySpent = BigInt(cache.dailySpent);
    const monthlySpent = BigInt(cache.monthlySpent);
    const dailyLimit = BigInt(cache.dailyLimit);
    const monthlyLimit = BigInt(cache.monthlyLimit);
    const spend = BigInt(amountCents);

    // Validate balance
    if (balance < spend) {
      await redis.unwatch();
      return { cache: null, error: "insufficient_balance" };
    }

    // Validate daily limit (0 = unlimited)
    if (dailyLimit > 0n && dailySpent + spend > dailyLimit) {
      await redis.unwatch();
      return { cache: null, error: "daily_limit" };
    }

    // Validate monthly limit (0 = unlimited)
    if (monthlyLimit > 0n && monthlySpent + spend > monthlyLimit) {
      await redis.unwatch();
      return { cache: null, error: "monthly_limit" };
    }

    cache.dailySpent = (dailySpent + spend).toString();
    cache.monthlySpent = (monthlySpent + spend).toString();
    cache.usdcBalance = (balance - spend).toString();
    cache.lastUpdated = Date.now();

    const pipeline = redis.multi();
    pipeline.set(key, JSON.stringify(cache), "EX", 300);
    const execResult = await pipeline.exec();

    if (!execResult) return { cache: null }; // Transaction failed (concurrent modification)
    return { cache };
  });

  return result;
}

// ============ Atomic Spend (Lua Script) ============

const SPEND_LUA_SCRIPT = `
local key = KEYS[1]
local spendAmount = ARGV[1]
local nowMs = ARGV[2]
local raw = redis.call('GET', key)
if not raw then return nil end

local cache = cjson.decode(raw)

-- Use string-to-number only via comparison helpers that handle large values
-- Redis Lua 5.1 has 64-bit integers in Redis 7+ via redis.math, but for
-- compatibility we compare as strings with zero-padding

local function str_gte(a, b)
  -- Compare two non-negative integer strings
  if #a ~= #b then return #a > #b end
  return a >= b
end

local function str_add(a, b)
  -- Add two non-negative integer strings
  local result = {}
  local carry = 0
  local la, lb = #a, #b
  local maxlen = math.max(la, lb)
  for i = 0, maxlen - 1 do
    local da = i < la and tonumber(a:sub(la - i, la - i)) or 0
    local db = i < lb and tonumber(b:sub(lb - i, lb - i)) or 0
    local sum = da + db + carry
    carry = math.floor(sum / 10)
    result[maxlen - i] = tostring(sum % 10)
  end
  if carry > 0 then table.insert(result, 1, tostring(carry)) end
  return table.concat(result)
end

local function str_sub(a, b)
  -- Subtract b from a (assumes a >= b), both non-negative integer strings
  local result = {}
  local borrow = 0
  local la, lb = #a, #b
  for i = 0, la - 1 do
    local da = tonumber(a:sub(la - i, la - i))
    local db = i < lb and tonumber(b:sub(lb - i, lb - i)) or 0
    local diff = da - db - borrow
    if diff < 0 then diff = diff + 10; borrow = 1 else borrow = 0 end
    result[la - i] = tostring(diff)
  end
  -- Remove leading zeros
  local s = table.concat(result)
  s = s:gsub("^0+", "")
  if s == "" then s = "0" end
  return s
end

local balance = cache.usdcBalance
local dailySpent = cache.dailySpent
local monthlySpent = cache.monthlySpent
local dailyLimit = cache.dailyLimit
local monthlyLimit = cache.monthlyLimit

-- Check balance: balance >= spendAmount
if not str_gte(balance, spendAmount) then
  return cjson.encode({error = "insufficient_balance"})
end

-- Check daily limit: if dailyLimit > "0", then dailySpent + spendAmount <= dailyLimit
if dailyLimit ~= "0" then
  local newDaily = str_add(dailySpent, spendAmount)
  if not str_gte(dailyLimit, newDaily) then
    return cjson.encode({error = "daily_limit"})
  end
end

-- Check monthly limit
if monthlyLimit ~= "0" then
  local newMonthly = str_add(monthlySpent, spendAmount)
  if not str_gte(monthlyLimit, newMonthly) then
    return cjson.encode({error = "monthly_limit"})
  end
end

-- Update values using string arithmetic
cache.usdcBalance = str_sub(balance, spendAmount)
cache.dailySpent = str_add(dailySpent, spendAmount)
cache.monthlySpent = str_add(monthlySpent, spendAmount)
cache.lastUpdated = nowMs

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
