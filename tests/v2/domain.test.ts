import { describe, expect, it } from "vitest";
import {
  decideLimits,
  decideQuota,
  decideTokenBucket,
  getCalendarBucket,
  hashApiKeySecret,
  hashPassword,
  isPermitted,
  issueApiKey,
  matchesPathPattern,
  parseApiKey,
  verifyApiKey,
  verifyPassword
} from "../../src/v2/domain/index.js";

describe("v2 API keys", () => {
  it("issues parseable keys and verifies only the matching secret", () => {
    const issued = issueApiKey("pepper");
    expect(issued.rawKey).toMatch(/^ogk_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{43}$/);
    const parsed = parseApiKey(issued.rawKey);
    expect(parsed).toEqual({ keyId: issued.keyId, secret: expect.any(String) });
    expect(parsed && hashApiKeySecret(parsed.secret, "pepper")).toBe(issued.secretHash);
    expect(verifyApiKey(issued.rawKey, { keyId: issued.keyId, secretHash: issued.secretHash }, "pepper")).toBe(true);
    expect(verifyApiKey(issued.rawKey, { keyId: issued.keyId, secretHash: issued.secretHash }, "wrong")).toBe(false);
    expect(verifyApiKey(`${issued.rawKey}x`, { keyId: issued.keyId, secretHash: issued.secretHash }, "pepper")).toBe(false);
  });

  it("rejects revoked, expired, and disabled credentials", () => {
    const issued = issueApiKey("pepper");
    const record = { keyId: issued.keyId, secretHash: issued.secretHash, expiresAt: new Date("2020-01-01") };
    expect(verifyApiKey(issued.rawKey, record, "pepper", { now: new Date("2021-01-01") })).toBe(false);
    expect(verifyApiKey(issued.rawKey, { ...record, expiresAt: null, revokedAt: new Date() }, "pepper")).toBe(false);
    expect(verifyApiKey(issued.rawKey, { ...record, expiresAt: null }, "pepper", { consumerEnabled: false })).toBe(false);
  });

  it("uses a keyed digest and never equates a different secret", () => {
    expect(hashApiKeySecret("secret", "a")).not.toBe(hashApiKeySecret("secret", "b"));
  });
});

describe("v2 passwords", () => {
  it("hashes and verifies passwords without storing the raw value", async () => {
    const encoded = await hashPassword("correct horse battery staple");
    expect(encoded).toMatch(/^\$argon2id\$/);
    expect(encoded).not.toContain("correct horse");
    expect(await verifyPassword("correct horse battery staple", encoded)).toBe(true);
    expect(await verifyPassword("wrong", encoded)).toBe(false);
    expect(await verifyPassword("correct horse battery staple", "bad hash")).toBe(false);
  });
});

describe("v2 permissions", () => {
  it("matches anchored method/path globs and excludes query strings", () => {
    expect(matchesPathPattern("/reports/today", "/reports/*")).toBe(true);
    expect(matchesPathPattern("/reports/2026/08", "/reports/*")).toBe(true);
    expect(matchesPathPattern("/other/reports/today", "/reports/*")).toBe(false);
    expect(matchesPathPattern("/reports?format=json", "/reports")).toBe(true);
    expect(isPermitted([{ apiId: "api-1", method: "get", pathPattern: "/reports" }], "api-1", "GET", "/reports")).toBe(true);
    expect(isPermitted([{ apiId: null, method: "*", pathPattern: "/*" }], "api-2", "POST", "/anything")).toBe(true);
    expect(isPermitted([{ apiId: "api-1", method: "GET", pathPattern: "/reports" }], "api-2", "GET", "/reports")).toBe(false);
  });
});

describe("v2 rate and quota decisions", () => {
  it("consumes a token bucket and rejects a burst after its capacity", () => {
    const first = decideTokenBucket(2, 60, null, 0);
    const second = decideTokenBucket(2, 60, first.state, 0);
    const third = decideTokenBucket(2, 60, second.state, 0);
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterSeconds).toBe(30);
    expect(decideTokenBucket(2, 60, third.state, 30_000).allowed).toBe(true);
  });

  it("resets quotas by calendar bucket and only allows the configured count", () => {
    const bucket = getCalendarBucket(new Date("2026-08-28T23:59:00Z"), "day", "UTC");
    expect(bucket.key).toBe("day:2026-08-28");
    const first = decideQuota(1, null, bucket.key, bucket.resetAtMs);
    expect(first.allowed).toBe(true);
    expect(decideQuota(1, first.state, bucket.key, bucket.resetAtMs).allowed).toBe(false);
    const next = getCalendarBucket(new Date("2026-08-29T00:00:00Z"), "day", "UTC");
    expect(decideQuota(1, first.state, next.key, next.resetAtMs).allowed).toBe(true);
    const manila = getCalendarBucket(new Date("2026-08-28T15:59:00Z"), "day", "Asia/Manila");
    expect(manila.key).toBe("day:2026-08-28");
    expect(manila.resetAtMs).toBe(Date.parse("2026-08-28T16:00:00Z"));
  });

  it("reports either active limiter as a blocking reason", () => {
    const result = decideLimits({
      limits: { rateLimitCount: 1, rateLimitWindowSeconds: 60, quotaCount: 1, quotaPeriod: "day" },
      rate: { tokens: 0, updatedAtMs: 0 },
      quota: { count: 1, bucketKey: "day:2026-08-28" },
      quotaBucketKey: "day:2026-08-28",
      quotaResetAtMs: 60_000,
      nowMs: 0
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons).toEqual(["rate", "quota"]);
  });
});
