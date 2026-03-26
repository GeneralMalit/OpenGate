import { describe, expect, it, vi } from "vitest";
import { createBufferedAuditLogger } from "../src/lib/audit.js";
import { createRedisRateLimitStore } from "../src/lib/rate_limit.js";
import type { AuditConfig, AuditEvent, OpenGateConfig } from "../src/lib/types.js";

function makeAuditEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  const { requestId: _requestId, ...rest } = overrides;
  return {
    occurredAt: "2026-03-25T00:00:00.000Z",
    requestId: "test-request-id",
    routePolicyId: "policy-1",
    identityType: "jwt",
    organizationId: "org-1",
    secondaryIdentifier: "user-1",
    method: "GET",
    path: "/api",
    statusCode: 200,
    latencyMs: 4,
    outcome: "allowed",
    blockReason: null,
    jwtClaimSnapshot: {
      iss: "issuer",
      aud: "audience",
      sub: "user-1"
    },
    ...rest
  };
}

describe("phase 4 backends", () => {
  it("uses an injected Redis client for rate limiting and respects key prefixes", async () => {
    let connectCalls = 0;
    let quitCalls = 0;
    let evalCalls = 0;
    const observedKeys: string[][] = [];
    const observedArguments: string[][] = [];

    const redisClient = {
      async connect() {
        connectCalls += 1;
      },
      async quit() {
        quitCalls += 1;
      },
      async eval(_script: string, options: { keys: string[]; arguments: string[] }) {
        evalCalls += 1;
        observedKeys.push(options.keys);
        observedArguments.push(options.arguments);

        const limit = Number(options.arguments[1]);
        return [evalCalls, Math.max(limit - evalCalls, 0)];
      }
    };

    const config: OpenGateConfig = {
      organizations: [],
      jwt: {
        issuers: [
          {
            issuer: "issuer",
            audiences: ["audience"],
            sharedSecret: "secret"
          }
        ]
      },
      apiKeys: {
        headerName: "x-api-key",
        clients: []
      },
      identityContext: {
        source: "jwt_claim",
        claim: "unique_user_id"
      },
      routePolicies: [],
      rateLimits: {
        store: "redis",
        redisUrl: "redis://localhost:6379",
        redisKeyPrefix: "custom-prefix",
        redisKeyExpirySeconds: 123,
        timezone: "UTC",
        free: { points: 1, duration: "calendar_day" },
        upgraded: { points: 1, duration: "calendar_day" }
      },
      audit: {
        enabled: false,
        sqlitePath: ":memory:"
      }
    };

    const store = createRedisRateLimitStore(config, redisClient);

    const first = await store.consume("2026-03-25", "jwt:user-1", 2);
    const second = await store.consume("2026-03-25", "jwt:user-1", 1);
    await store.close?.();

    expect(connectCalls).toBe(1);
    expect(quitCalls).toBe(0);
    expect(evalCalls).toBe(2);
    expect(observedKeys).toEqual([
      ["custom-prefix:2026-03-25:jwt%3Auser-1"],
      ["custom-prefix:2026-03-25:jwt%3Auser-1"]
    ]);
    expect(observedArguments).toEqual([
      ["123", "2"],
      ["123", "1"]
    ]);
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(1);
    expect(second.allowed).toBe(false);
    expect(second.remaining).toBe(0);
  });

  it("flushes buffered audit events and retries after a failed batch write", async () => {
    const writtenPolicies: string[] = [];
    let writeCalls = 0;
    let closeCalls = 0;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sink = {
      async writeBatch(events: AuditEvent[]) {
        writeCalls += 1;
        if (writeCalls === 1) {
          throw new Error("temporary sink failure");
        }

        writtenPolicies.push(...events.map((event) => event.routePolicyId));
      },
      async close() {
        closeCalls += 1;
      }
    };

    const auditConfig: AuditConfig = {
      enabled: true,
      sqlitePath: ":memory:",
      flushIntervalMs: 1,
      batchSize: 2,
      maxQueueSize: 10
    };

    const logger = createBufferedAuditLogger(auditConfig, sink);
    try {
      logger.log(makeAuditEvent({ routePolicyId: "policy-a" }));
      logger.log(makeAuditEvent({ routePolicyId: "policy-b" }));
      logger.log(makeAuditEvent({ routePolicyId: "policy-c" }));

      await logger.close();

      expect(writeCalls).toBe(3);
      expect(writtenPolicies).toEqual(["policy-a", "policy-b", "policy-c"]);
      expect(closeCalls).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});


