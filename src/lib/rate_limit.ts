import { createClient } from "redis";
import type { OpenGateConfig, RateLimitResult, RateLimitStore, RequestIdentity } from "./types.js";

const DEFAULT_REDIS_KEY_PREFIX = "opengate:rate-limit";
const DEFAULT_REDIS_KEY_EXPIRY_SECONDS = 60 * 60 * 24 * 2;

const REDIS_INCREMENT_SCRIPT = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end
local limit = tonumber(ARGV[2])
local remaining = limit - current
if remaining < 0 then
  remaining = 0
end
return {current, remaining}
`;

export type RedisRateLimitClient = {
  connect: () => Promise<void>;
  quit: () => Promise<void>;
  eval: (script: string, options: { keys: string[]; arguments: string[] }) => Promise<unknown>;
};

export function createRateLimitStore(config: OpenGateConfig, customStore?: RateLimitStore): RateLimitStore {
  if (customStore) {
    return customStore;
  }

  if ((config.rateLimits.store ?? "memory") === "redis") {
    return createRedisRateLimitStore(config);
  }

  return new InMemoryRateLimitStore();
}

export function createRedisRateLimitStore(
  config: OpenGateConfig,
  client?: RedisRateLimitClient
): RateLimitStore {
  const redisClient = client ?? createClient({ url: config.rateLimits.redisUrl });
  const ownsClient = !client;
  let connected = false;
  let connectPromise: Promise<void> | null = null;

  return {
    async consume(bucketKey: string, subjectKey: string, limit: number): Promise<RateLimitResult> {
      await ensureConnected();

      const prefix = config.rateLimits.redisKeyPrefix ?? DEFAULT_REDIS_KEY_PREFIX;
      const redisKey = `${prefix}:${encodeKey(bucketKey)}:${encodeKey(subjectKey)}`;
      const expirySeconds = config.rateLimits.redisKeyExpirySeconds ?? DEFAULT_REDIS_KEY_EXPIRY_SECONDS;
      const result = await redisClient.eval(REDIS_INCREMENT_SCRIPT, {
        keys: [redisKey],
        arguments: [String(expirySeconds), String(limit)]
      });

      const [current, remaining] = parseRedisResult(result);

      return {
        allowed: current <= limit,
        limit,
        remaining,
        resetBucket: bucketKey
      };
    },
    async close() {
      if (ownsClient) {
        await redisClient.quit();
      }
    }
  };

  async function ensureConnected() {
    if (connected) {
      return;
    }

    connectPromise ??= redisClient.connect().then(() => {
      connected = true;
    });

    await connectPromise;
  }

  function encodeKey(value: string) {
    return encodeURIComponent(value);
  }

  function parseRedisResult(result: unknown): [number, number] {
    if (Array.isArray(result) && result.length >= 2) {
      const current = Number(result[0]);
      const remaining = Number(result[1]);
      return [Number.isFinite(current) ? current : 0, Number.isFinite(remaining) ? remaining : 0];
    }

    return [0, 0];
  }
}

export async function consumeRateLimit(
  store: RateLimitStore,
  config: OpenGateConfig,
  identity: RequestIdentity,
  now = new Date()
): Promise<RateLimitResult> {
  const bucketKey = getCalendarDayBucket(now, config.rateLimits.timezone ?? "UTC");
  const subjectKey = identity.rateLimitSubject;
  const tier = identity.tier === "free" ? config.rateLimits.free : config.rateLimits.upgraded;

  if (tier.duration !== "calendar_day") {
    throw new Error(`Unsupported rate limit duration: ${tier.duration}`);
  }

  return await store.consume(bucketKey, subjectKey, tier.points);
}

export function getCalendarDayBucket(date: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });

  const parts = formatter.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    throw new Error(`Unable to compute calendar-day bucket for timezone "${timeZone}".`);
  }

  return `${year}-${month}-${day}`;
}

class InMemoryRateLimitStore implements RateLimitStore {
  private readonly counts = new Map<string, number>();

  consume(bucketKey: string, subjectKey: string, limit: number): RateLimitResult {
    const compositeKey = `${bucketKey}:${subjectKey}`;
    const current = this.counts.get(compositeKey) ?? 0;

    if (current >= limit) {
      return {
        allowed: false,
        limit,
        remaining: 0,
        resetBucket: bucketKey
      };
    }

    const next = current + 1;
    this.counts.set(compositeKey, next);

    return {
      allowed: true,
      limit,
      remaining: Math.max(limit - next, 0),
      resetBucket: bucketKey
    };
  }
}
