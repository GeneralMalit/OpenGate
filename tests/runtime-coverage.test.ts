import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import express from "express";
import Fastify from "fastify";
import supertest from "supertest";
import { createOpenGate, createFastifyOpenGate, createExpressOpenGate } from "../src/index.js";
import { createExpressOpenGate as createExpressOpenGateShim } from "../src/express.js";
import { createGateEngine } from "../src/lib/engine.js";
import { createConsoleLoggerAdapter, createOpenGateTelemetry, resolveOperationalPaths } from "../src/lib/observability.js";
import { resolveRoutePolicy } from "../src/lib/policies.js";
import {
  getHeaderValue,
  normalizeCookies,
  normalizeHeaders,
  parseCookieHeader,
  resolveRequestId
} from "../src/lib/request.js";
import { consumeRateLimit, createRateLimitStore } from "../src/lib/rate_limit.js";
import {
  createApiClientConfig,
  createApiKeyVersionConfig,
  authorizeRequest,
  hashApiKey
} from "../src/lib/auth.js";
import {
  ConfigValidationError,
  loadConfig,
  migrateConfig,
  validateConfig,
  validateConfigDetailed
} from "../src/lib/config.js";
import { createJwksTestServer, createTestConfig, signTestJwt } from "./helpers.js";

describe("runtime coverage", () => {
  it("covers request normalization helpers", () => {
    const headers = normalizeHeaders({
      Authorization: "Bearer token",
      "X-Request-Id": "req-1",
      cookie: "a=1; b=two"
    });

    expect(getHeaderValue(headers, "authorization")).toBe("Bearer token");
    expect(getHeaderValue(headers, "x-request-id")).toBe("req-1");
    expect(getHeaderValue({ multi: ["first", "second"] }, "multi")).toBe("first");
    expect(normalizeHeaders({ Count: 42, Multi: ["a", "b"], Empty: undefined })).toMatchObject({
      count: "42",
      multi: ["a", "b"],
      empty: undefined
    });
    expect(resolveRequestId(headers, "x-request-id", "fallback")).toBe("req-1");
    expect(parseCookieHeader("foo=bar; encoded=a%20b")).toEqual({ foo: "bar", encoded: "a b" });
    expect(parseCookieHeader("bad=1; =skip; good=2")).toEqual({ bad: "1", good: "2" });
    expect(normalizeCookies({ a: "1", b: undefined, c: "" })).toEqual({ a: "1" });
    expect(normalizeCookies(undefined)).toBeUndefined();
    expect(parseCookieHeader(undefined)).toBeUndefined();
  });

  it("covers route policy resolution and explicit overrides", () => {
    const config = createTestConfig({
      routePolicies: [
        { id: "public", pathPrefix: "/api", accessMode: "public", requiredScopes: [] as string[], enabled: true },
        { id: "nested", pathPrefix: "/api/admin", accessMode: "authenticated", requiredScopes: ["admin:read"], enabled: true }
      ]
    });

    expect(resolveRoutePolicy(config, "/api/admin/users")).toMatchObject({
      id: "nested",
      pathPrefix: "/api/admin",
      accessMode: "authenticated"
    });
    expect(resolveRoutePolicy(config, "/elsewhere", { accessMode: "public" })).toMatchObject({
      id: "implicit:/elsewhere",
      accessMode: "public"
    });
    expect(() => resolveRoutePolicy({ ...config, routePolicies: [] }, "/missing")).toThrow();
  });

  it("covers config validation, migration, and storage backend checks", () => {
    const base = {
      organizations: [{ id: "org-1", name: "Org 1", enabled: true }],
      users: [{ id: "user-1", name: "User 1", organizationId: "org-1", enabled: true }],
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
        clients: [
          {
            id: "client-1",
            name: "Client 1",
            organizationId: "org-1",
            userId: "user-1",
            keyHash: hashApiKey("raw-key")
          }
        ]
      },
      identityContext: { source: "jwt_claim", claim: "unique_user_id" },
      routePolicies: [{ id: "public", pathPrefix: "/api", accessMode: "public", requiredScopes: [] as string[], enabled: true }],
      rateLimits: {
        timezone: "UTC",
        store: "memory",
        free: { points: 10, duration: "calendar_day" },
        upgraded: { points: 1000, duration: "calendar_day" }
      },
      audit: {
        enabled: true,
        sqlitePath: ":memory:",
        jwtClaimSnapshot: ["iss", "aud", "sub", "org_id", "unique_user_id"]
      }
    };

    const detailed = validateConfigDetailed(base);
    expect(detailed.ok).toBe(true);
    if (detailed.ok) {
      expect(detailed.config.jwt.issuers[0]?.verificationMode).toBe("shared_secret");
      expect(detailed.config.apiKeys.clients[0]?.keyVersions).toHaveLength(1);
    }

    const migrated = migrateConfig(base);
    expect(migrated.warnings.length).toBeGreaterThan(0);

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "opengate-config-"));
    try {
      const configPath = path.join(tempDir, "opengate.config.json");
      fs.writeFileSync(configPath, JSON.stringify(base, null, 2));
      expect(loadConfig(configPath)).toMatchObject({
        organizations: [{ id: "org-1" }]
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    expect(() =>
      validateConfig({
        ...base,
        rateLimits: {
          ...base.rateLimits,
          store: "redis",
          redisUrl: undefined
        }
      })
    ).toThrow(ConfigValidationError);

    expect(() =>
      validateConfig({
        ...base,
        audit: {
          ...base.audit,
          jwtClaimSnapshot: ["iss", "email"]
        }
      })
    ).toThrow(/Unsupported claim "email"/);
  });

  it("covers JWT and API-key authorization branches", async () => {
    const config = createTestConfig({
      users: [
        { id: "user-1", name: "User 1", organizationId: "org-active", enabled: true },
        { id: "user-disabled", name: "Disabled User", organizationId: "org-disabled", enabled: false }
      ],
      behavior: {
        onMissingSecondaryIdentifier: "reject",
        onCredentialMismatch: "deny",
        onDisabledOrganization: "block"
      }
    });
    const normalizedConfig = validateConfig(config);
    const jwtPolicy = { id: "jwt", pathPrefix: "/jwt", accessMode: "jwt", requiredScopes: [] as string[], enabled: true } as const;
    const authenticatedPolicy = { id: "auth", pathPrefix: "/auth", accessMode: "authenticated", requiredScopes: [] as string[], enabled: true } as const;
    const publicPolicy = { id: "public", pathPrefix: "/api", accessMode: "public", requiredScopes: [] as string[], enabled: true } as const;

    await expect(authorizeRequest(normalizedConfig, jwtPolicy, {
      method: "GET",
      url: "/jwt",
      path: "/jwt",
      ip: "127.0.0.1",
      requestId: "req-1",
      headers: {}
    })).resolves.toMatchObject({
      allowed: false,
      statusCode: 401,
      blockReason: "jwt_required"
    });

    const jwtToken = await signTestJwt();
    const jwtDecision = await authorizeRequest(normalizedConfig, jwtPolicy, {
      method: "GET",
      url: "/jwt",
      path: "/jwt",
      ip: "127.0.0.1",
      requestId: "req-2",
      headers: { authorization: `Bearer ${jwtToken}` }
    });
    expect(jwtDecision.allowed).toBe(true);
    if (jwtDecision.allowed) {
      expect(jwtDecision.identity.identityType).toBe("jwt");
    }

    const apiDecision = await authorizeRequest(normalizedConfig, publicPolicy, {
      method: "GET",
      url: "/api",
      path: "/api",
      ip: "127.0.0.1",
      requestId: "req-3",
      headers: { "x-api-key": "raw-client-key-1" }
    });
    expect(apiDecision).toMatchObject({ allowed: true });
    if (apiDecision.allowed) {
      expect(apiDecision.identity.identityType).toBe("api_key");
    }

    const mismatchDecision = await authorizeRequest(normalizedConfig, authenticatedPolicy, {
      method: "GET",
      url: "/auth",
      path: "/auth",
      ip: "127.0.0.1",
      requestId: "req-4",
      headers: {
        authorization: `Bearer ${jwtToken}`,
        "x-api-key": "raw-client-key-2"
      }
    });
    expect(mismatchDecision.allowed).toBe(false);
    if (!mismatchDecision.allowed) {
      expect(mismatchDecision.blockReason).toBe("user_not_found");
    }

    const publicDecision = await authorizeRequest(normalizedConfig, publicPolicy, {
      method: "GET",
      url: "/api",
      path: "/api",
      ip: "127.0.0.1",
      requestId: "req-5",
      headers: {}
    });
    expect(publicDecision.allowed).toBe(true);

    const jwks = await createJwksTestServer();
    try {
      const signingKey = await jwks.createSigningKey("kid-1");
      jwks.publishKeys([signingKey]);
      const jwksConfig = validateConfig(createTestConfig({
        jwt: {
          cookieName: "opengate_test_jwt",
          issuers: [
            {
              issuer: jwks.issuer,
              audiences: [jwks.audience],
              verificationMode: "jwks",
              jwksUrl: jwks.jwksUrl,
              allowedAlgorithms: ["RS256"],
              cacheTtlMs: 1_000,
              requestTimeoutMs: 1_000,
              organizationClaim: "org_id",
              subjectClaim: "sub",
              requiredClaims: ["iss", "aud", "exp", "sub", "unique_user_id"],
              optionalClaims: ["scope"]
            }
          ]
        }
      }));
      const token = await jwks.signJwt(signingKey);
      const jwksDecision = await authorizeRequest(jwksConfig, jwtPolicy, {
        method: "GET",
        url: "/jwt",
        path: "/jwt",
        ip: "127.0.0.1",
        requestId: "req-6",
        headers: { authorization: `Bearer ${token}` }
      });
      expect(jwksDecision.allowed).toBe(true);
    } finally {
      await jwks.close();
    }

    const disabledOrgDecision = await authorizeRequest(
      validateConfig(createTestConfig()),
      jwtPolicy,
      {
        method: "GET",
        url: "/jwt",
        path: "/jwt",
        ip: "127.0.0.1",
        requestId: "req-7",
        headers: { authorization: `Bearer ${await signTestJwt({ org_id: "org-disabled" })}` }
      }
    );
    expect(disabledOrgDecision.allowed).toBe(false);
    if (!disabledOrgDecision.allowed) {
      expect(disabledOrgDecision.blockReason).toBe("organization_disabled");
    }
  });

  it("covers engine, telemetry, and logger behavior", async () => {
    const telemetryConfig = createTestConfig({
      observability: {
        requestIdHeader: "x-request-id",
        healthPath: "/healthz",
        readyPath: "/readyz",
        metricsPath: "/metrics",
        statusPath: "/status"
      },
      audit: {
        enabled: false,
        sqlitePath: ":memory:"
      }
    });
    const logger = { emit: vi.fn() };
    const telemetry = createOpenGateTelemetry(telemetryConfig, logger);

    const allowedContext = {
      startedAt: process.hrtime.bigint(),
      requestId: "req-allowed",
      routePolicy: { id: "public", pathPrefix: "/api", accessMode: "public", requiredScopes: [] as string[], enabled: true },
      identity: { identityType: "anonymous", tier: "free", scopes: [], rateLimitSubject: "127.0.0.1" },
      outcome: "allowed" as const,
      blockReason: null,
      jwtClaimSnapshot: null,
      auditLogged: false
    };

    const blockedContext = {
      ...allowedContext,
      requestId: "req-blocked",
      outcome: "blocked" as const,
      blockReason: "rate_limited" as const
    };

    telemetry.recordRequestFinalized(allowedContext as never, { method: "GET", path: "/api", url: "/api" }, 200);
    telemetry.recordRequestFinalized(blockedContext as never, { method: "GET", path: "/api", url: "/api" }, 429);
    telemetry.recordAuditBatchWritten([]);
    telemetry.recordAuditBatchFailed([], new Error("ignored"));
    telemetry.recordAuditBatchDropped([]);
    telemetry.recordAuditBatchWritten([{ routePolicyId: "public" } as never]);
    telemetry.recordAuditBatchFailed([{ routePolicyId: "public", requestId: "req-1" } as never], new Error("sink failed"));
    telemetry.recordAuditBatchDropped([{ routePolicyId: "public", requestId: "req-2" } as never]);
    telemetry.recordHealthCheck("/readyz");
    telemetry.recordHealthCheck("/healthz");

    const telemetryWithoutLogger = createOpenGateTelemetry(telemetryConfig);
    telemetryWithoutLogger.recordAuditBatchFailed([{ routePolicyId: "public", requestId: "req-3" } as never], new Error("no logger"));
    telemetryWithoutLogger.recordAuditBatchDropped([{ routePolicyId: "public", requestId: "req-4" } as never]);

    expect(telemetry.getRequestIdHeader()).toBe("x-request-id");
    expect(telemetry.getMetricsSnapshot().requestsTotal).toBeGreaterThan(0);
    expect(telemetry.getStatusSnapshot().status).toBe("ready");

    const consoleLogger = createConsoleLoggerAdapter();
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      consoleLogger.emit({ timestamp: "now", level: "info", event: "request.allowed", requestId: "r", routePolicyId: "p", method: "GET", path: "/api", identityType: "anonymous", tier: "free", statusCode: 200, outcome: "allowed", blockReason: null, latencyMs: 1 });
      consoleLogger.emit({ timestamp: "now", level: "warn", event: "request.blocked", requestId: "r", routePolicyId: "p", method: "GET", path: "/api", identityType: "anonymous", tier: "free", statusCode: 429, outcome: "blocked", blockReason: "rate_limited", latencyMs: 1 });
      consoleLogger.emit({ timestamp: "now", level: "error", event: "audit.write.failed", requestId: "r", routePolicyId: "p", method: "GET", path: "/api", identityType: "anonymous", tier: "free", statusCode: 500, outcome: "blocked", blockReason: "boom", latencyMs: 1 });
      expect(infoSpy).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("covers gate and adapter shims directly", async () => {
    const config = createTestConfig({
      routePolicies: [
        { id: "shim", pathPrefix: "/shim", accessMode: "public", requiredScopes: [] as string[], enabled: true }
      ],
      audit: {
        enabled: false,
        sqlitePath: ":memory:"
      }
    });

    const fastifyGate = createOpenGate(config);
    const fastifyAlias = createFastifyOpenGate(config);
    expect(fastifyAlias.registerProtectedRoute).toBeTypeOf("function");
    expect(fastifyGate.registerProtectedRoute).toBeTypeOf("function");

    const fastifyApp = Fastify({ logger: false });
    fastifyGate.registerProtectedRoute(fastifyApp, {
      path: "/shim",
      method: "GET",
      accessMode: "public",
      handler: async (request) => ({
        ok: true,
        identityType: request.opengate?.identity.identityType ?? "anonymous"
      })
    });

    const fastifyResponse = await fastifyApp.inject({ method: "GET", url: "/shim" });
    expect(fastifyResponse.statusCode).toBe(200);
    await fastifyApp.close();
    await fastifyGate.close();
    await fastifyAlias.close();

    const expressGate = createExpressOpenGate(config);
    const expressShimGate = createExpressOpenGateShim(config);
    const expressApp = express();
    expressGate.registerProtectedRoute(expressApp, {
      path: "/shim",
      method: "GET",
      accessMode: "public",
      handler: async (request) => ({
        ok: true,
        identityType: request.opengate?.identity.identityType ?? "anonymous"
      })
    });
    const expressResponse = await supertest(expressApp).get("/shim");
    expect(expressResponse.status).toBe(200);
    await expressGate.close();
    await expressShimGate.close();

    expect(resolveOperationalPaths(config)).toMatchObject({
      healthPath: "/healthz",
      readyPath: "/readyz",
      metricsPath: "/metrics",
      statusPath: "/status"
    });
  });

  it("covers rate-limit factory and guard branches", async () => {
    const customStore = {
      consume: vi.fn(async () => ({
        allowed: true,
        limit: 7,
        remaining: 6,
        resetBucket: "bucket"
      })),
      close: vi.fn(async () => undefined)
    };

    const config = createTestConfig();
    expect(createRateLimitStore(config, customStore as never)).toBe(customStore);

    await expect(
      consumeRateLimit(customStore as never, {
        ...config,
        rateLimits: {
          ...config.rateLimits,
          free: { ...config.rateLimits.free, duration: "rolling_hour" as never }
        }
      }, {
        identityType: "anonymous",
        tier: "free",
        scopes: [],
        rateLimitSubject: "127.0.0.1"
      } as never)
    ).rejects.toThrow(/Unsupported rate limit duration/);
  });

  it("covers the CLI entrypoint wrapper", () => {
    const output = execFileSync(process.execPath, ["--import", "tsx", path.join(process.cwd(), "src", "cli.ts"), "help"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    expect(output).toContain("OpenGate CLI");
  });

  it("covers api-client helper creation", () => {
    const client = createApiClientConfig({
      id: "client-x",
      name: "Client X",
      organizationId: "org-active",
      userId: "user-1",
      rawKey: "secret",
      scopes: ["time:read"],
      enabled: true
    });
    const version = createApiKeyVersionConfig({
      id: "client-x-v2",
      rawKey: "secret-v2",
      createdAt: "2026-03-25T00:00:00.000Z",
      enabled: true
    });

    expect(client.keyVersions).toHaveLength(1);
    expect(client.keyVersions?.[0]?.keyHash).toBe(hashApiKey("secret"));
    expect(version.keyHash).toBe(hashApiKey("secret-v2"));
  });
});


