import type { QuotaPeriod, RoleLimits, QuotaState, TokenBucketState } from "./types.js";

export interface NormalizedRoleLimits {
  rateLimitCount: number | null;
  rateLimitWindowSeconds: number | null;
  quotaCount: number | null;
  quotaPeriod: QuotaPeriod | null;
}

export interface TokenBucketDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
  state: TokenBucketState;
}

export interface QuotaDecision {
  allowed: boolean;
  remaining: number;
  resetAtMs: number;
  state: QuotaState;
}

export interface LimitDecision {
  allowed: boolean;
  reasons: Array<"rate" | "quota">;
  rate?: TokenBucketDecision;
  quota?: QuotaDecision;
  retryAfterSeconds?: number;
}

export function normalizeRoleLimits(limits: RoleLimits): NormalizedRoleLimits {
  const rateSet = limits.rateLimitCount != null || limits.rateLimitWindowSeconds != null;
  const quotaSet = limits.quotaCount != null || limits.quotaPeriod != null;
  if (rateSet && (limits.rateLimitCount == null || limits.rateLimitWindowSeconds == null)) throw new Error("Rate limit count and window must be configured together.");
  if (quotaSet && (limits.quotaCount == null || limits.quotaPeriod == null)) throw new Error("Quota count and period must be configured together.");
  if (limits.rateLimitCount != null && (!Number.isSafeInteger(limits.rateLimitCount) || limits.rateLimitCount <= 0)) throw new Error("Rate limit count must be a positive integer.");
  if (limits.rateLimitWindowSeconds != null && (!Number.isSafeInteger(limits.rateLimitWindowSeconds) || limits.rateLimitWindowSeconds <= 0)) throw new Error("Rate limit window must be a positive integer.");
  if (limits.quotaCount != null && (!Number.isSafeInteger(limits.quotaCount) || limits.quotaCount <= 0)) throw new Error("Quota count must be a positive integer.");
  if (limits.quotaPeriod != null && limits.quotaPeriod !== "day" && limits.quotaPeriod !== "month") throw new Error("Quota period must be day or month.");
  return { rateLimitCount: limits.rateLimitCount ?? null, rateLimitWindowSeconds: limits.rateLimitWindowSeconds ?? null, quotaCount: limits.quotaCount ?? null, quotaPeriod: limits.quotaPeriod ?? null };
}

export function decideTokenBucket(limit: number, windowSeconds: number, current: TokenBucketState | null, nowMs = Date.now()): TokenBucketDecision {
  if (!Number.isSafeInteger(limit) || limit <= 0 || !Number.isFinite(windowSeconds) || windowSeconds <= 0) throw new Error("Invalid token bucket configuration.");
  const previous = current && Number.isFinite(current.tokens) && Number.isFinite(current.updatedAtMs) ? current : { tokens: limit, updatedAtMs: nowMs };
  const elapsed = Math.max(0, nowMs - previous.updatedAtMs) / 1000;
  const refilled = Math.min(limit, Math.max(0, previous.tokens) + elapsed * (limit / windowSeconds));
  if (refilled < 1) {
    const retryAfterSeconds = Math.max(1, Math.ceil((1 - refilled) * windowSeconds / limit));
    return { allowed: false, remaining: 0, retryAfterSeconds, state: { tokens: refilled, updatedAtMs: nowMs } };
  }
  const tokens = refilled - 1;
  return { allowed: true, remaining: Math.floor(tokens), retryAfterSeconds: 0, state: { tokens, updatedAtMs: nowMs } };
}

export function decideQuota(limit: number, current: QuotaState | null, bucketKey: string, resetAtMs: number): QuotaDecision {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("Invalid quota configuration.");
  const count = current?.bucketKey === bucketKey && Number.isSafeInteger(current.count) ? current.count : 0;
  if (count >= limit) return { allowed: false, remaining: 0, resetAtMs, state: { count, bucketKey } };
  const next = count + 1;
  return { allowed: true, remaining: limit - next, resetAtMs, state: { count: next, bucketKey } };
}

export function decideLimits(input: {
  limits: RoleLimits;
  rate?: TokenBucketState | null;
  quota?: QuotaState | null;
  quotaBucketKey?: string;
  quotaResetAtMs?: number;
  nowMs?: number;
}): LimitDecision {
  const limits = normalizeRoleLimits(input.limits);
  const nowMs = input.nowMs ?? Date.now();
  const result: LimitDecision = { allowed: true, reasons: [] };
  if (limits.rateLimitCount != null && limits.rateLimitWindowSeconds != null) {
    result.rate = decideTokenBucket(limits.rateLimitCount, limits.rateLimitWindowSeconds, input.rate ?? null, nowMs);
    if (!result.rate.allowed) result.reasons.push("rate");
  }
  if (limits.quotaCount != null && limits.quotaPeriod != null) {
    if (!input.quotaBucketKey || input.quotaResetAtMs == null) throw new Error("Quota bucket key and reset time are required.");
    result.quota = decideQuota(limits.quotaCount, input.quota ?? null, input.quotaBucketKey, input.quotaResetAtMs);
    if (!result.quota.allowed) result.reasons.push("quota");
  }
  result.allowed = result.reasons.length === 0;
  if (!result.allowed) result.retryAfterSeconds = result.rate?.allowed === false ? result.rate.retryAfterSeconds : result.quota ? Math.max(1, Math.ceil((result.quota.resetAtMs - nowMs) / 1000)) : undefined;
  return result;
}

export function getCalendarBucket(date: Date | number, period: QuotaPeriod, timeZone = "UTC"): { key: string; resetAtMs: number } {
  const instant = typeof date === "number" ? new Date(date) : date;
  if (Number.isNaN(instant.getTime())) throw new Error("Invalid date.");
  const parts = localParts(instant, timeZone);
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");
  const key = period === "day" ? `day:${parts.year}-${month}-${day}` : `month:${parts.year}-${month}`;
  const next = period === "day" ? addUtcDays(parts.year, parts.month, parts.day, 1) : addUtcMonths(parts.year, parts.month, 1);
  const resetAtMs = findLocalMidnight(next.year, next.month, period === "day" ? next.day : 1, timeZone);
  return { key, resetAtMs };
}

function localParts(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const year = value("year"); const month = value("month"); const day = value("day");
  if (![year, month, day].every(Number.isFinite)) throw new Error(`Invalid timezone: ${timeZone}`);
  return { year, month, day };
}

function addUtcDays(year: number, month: number, day: number, amount: number) { const d = new Date(Date.UTC(year, month - 1, day + amount)); return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }; }
function addUtcMonths(year: number, month: number, amount: number) { const d = new Date(Date.UTC(year, month - 1 + amount, 1)); return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: 1 }; }

function findLocalMidnight(year: number, month: number, day: number, timeZone: string): number {
  const target = Date.UTC(year, month - 1, day);
  // Convert the desired wall-clock midnight to UTC using the timezone's
  // offset at that date. Recalculate once more for DST boundaries.
  let guess = target - timeZoneOffsetMs(new Date(target), timeZone);
  guess = target - timeZoneOffsetMs(new Date(guess), timeZone);
  return guess;
}

function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const parts = formatter.formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const wallClock = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second"));
  return wallClock - date.getTime();
}
