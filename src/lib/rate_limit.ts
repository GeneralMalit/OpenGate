import type { OpenGateConfig, RateLimitResult, RateLimitStore, RequestIdentity } from "./types.js";

export function createRateLimitStore(config: OpenGateConfig, customStore?: RateLimitStore): RateLimitStore {
  if (customStore) {
    return customStore;
  }

  if (config.rateLimits.store === "memory") {
    return new InMemoryRateLimitStore();
  }

  throw new Error(`Unsupported rate limit store without injected implementation: ${config.rateLimits.store}`);
}

export function consumeRateLimit(
  store: RateLimitStore,
  config: OpenGateConfig,
  identity: RequestIdentity,
  now = new Date()
): RateLimitResult {
  const bucketKey = getCalendarDayBucket(now, config.rateLimits.timezone ?? "UTC");
  const subjectKey = identity.rateLimitSubject;
  const tier = identity.tier === "free" ? config.rateLimits.free : config.rateLimits.upgraded;

  if (tier.duration !== "calendar_day") {
    throw new Error(`Unsupported rate limit duration: ${tier.duration}`);
  }

  return store.consume(bucketKey, subjectKey, tier.points);
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
