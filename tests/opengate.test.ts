import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenGate, hashApiKey, loadConfig, validateConfig } from "../src/index.js";
import { consumeRateLimit, createRateLimitStore, getCalendarDayBucket } from "../src/lib/rate_limit.js";
import { createJwksTestServer, createTestApp, createTestConfig, readAuditRows, signTestJwt } from "./helpers.js";

const appsToClose: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (appsToClose.length > 0) {
    const close = appsToClose.pop();
    await close?.();
  }
  vi.useRealTimers();
});

describe("config and library surface", () => {
  it("loads a valid JSON config and exports a reusable gate", () => {
    const configPath = path.join(process.cwd(), "opengate.config.json");
    const config = loadConfig(configPath);
    const gate = createOpenGate(config);

    expect(config.routePolicies[0]?.id).toBe("example-api");
    expect(typeof gate.registerProtectedRoute).toBe("function");
    gate.close();
  });

  it("rejects malformed config values", () => {
    expect(() =>
      validateConfig({
        organizations: [],
        jwt: { issuers: [] },
        apiKeys: { headerName: "x-api-key", clients: [] },
        identityContext: { source: "jwt_claim", claim: "unique_user_id" },
        routePolicies: []
      })
    ).toThrow();
  });

  it("resolves relative sqlite paths against the config base directory", () => {
    const config = validateConfig(
      {
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
        apiKeys: { headerName: "x-api-key", clients: [] },
        identityContext: { source: "jwt_claim", claim: "unique_user_id" },
        routePolicies: [
          { id: "public", pathPrefix: "/api", accessMode: "public" }
        ],
        rateLimits: {
          free: { points: 10, duration: "calendar_day" },
          upgraded: { points: 1000, duration: "calendar_day" }
        },
        audit: { enabled: true, sqlitePath: "./relative.db" }
      },
      "D:/tmp/opengate-config"
    );

    expect(config.audit.sqlitePath).toContain(path.join("D:/tmp/opengate-config", "relative.db").replace(/\//g, path.sep));
  });

  it("supports an injected custom rate-limit store", () => {
    const config = createTestConfig({
      rateLimits: {
        timezone: "UTC",
        store: "memory",
        free: { points: 10, duration: "calendar_day" },
        upgraded: { points: 1000, duration: "calendar_day" }
      }
    });

    const customStore = {
      consume: () => ({
        allowed: true as const,
        limit: 99,
        remaining: 98,
        resetBucket: "2026-03-25"
      })
    };

    const gate = createOpenGate({
      config,
      rateLimitStore: customStore
    });

    expect(gate.config.rateLimits.store).toBe("memory");
    gate.close();
  });

  it("normalizes legacy shared-secret issuers and keyHash API clients into Phase 1 structures", () => {
    const config = validateConfig({
      organizations: [{ id: "org-1", name: "Org 1", enabled: true }],
      jwt: {
        issuers: [
          {
            issuer: "legacy-issuer",
            audiences: ["legacy-audience"],
            sharedSecret: "legacy-secret"
          }
        ]
      },
      apiKeys: {
        headerName: "x-api-key",
        clients: [
          {
            id: "legacy-client",
            name: "Legacy Client",
            organizationId: "org-1",
            userId: "user-1",
            keyHash: hashApiKey("legacy-raw-key")
          }
        ]
      },
      identityContext: { source: "jwt_claim", claim: "unique_user_id" },
      routePolicies: [
        { id: "public", pathPrefix: "/api", accessMode: "public" }
      ],
      rateLimits: {
        free: { points: 10, duration: "calendar_day" },
        upgraded: { points: 1000, duration: "calendar_day" }
      },
      audit: { enabled: true, sqlitePath: ":memory:" }
    });

    expect(config.jwt.issuers[0]?.verificationMode).toBe("shared_secret");
    expect(config.apiKeys.clients[0]?.keyVersions).toHaveLength(1);
    expect(config.apiKeys.clients[0]?.keyVersions?.[0]?.id).toBe("legacy-client-legacy-key");
  });

  it("rejects unsupported audit claim snapshots", () => {
    expect(() => validateConfig({
      organizations: [{ id: "org-1", name: "Org 1", enabled: true }],
      jwt: {
        issuers: [
          {
            issuer: "issuer",
            audiences: ["audience"],
            sharedSecret: "secret"
          }
        ]
      },
      apiKeys: { headerName: "x-api-key", clients: [] },
      identityContext: { source: "jwt_claim", claim: "unique_user_id" },
      routePolicies: [
        { id: "public", pathPrefix: "/api", accessMode: "public" }
      ],
      rateLimits: {
        free: { points: 10, duration: "calendar_day" },
        upgraded: { points: 1000, duration: "calendar_day" }
      },
      audit: {
        enabled: true,
        sqlitePath: ":memory:",
        jwtClaimSnapshot: ["iss", "email"]
      }
    })).toThrow('Unsupported claim "email"');
  });
});

describe("route protection and identity resolution", () => {
  it("allows anonymous public traffic through a public route", async () => {
    const { app } = await createTestApp();
    appsToClose.push(() => app.close());

    const response = await app.inject({ method: "GET", url: "/api", remoteAddress: "10.0.0.5" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      identityType: "anonymous",
      policyId: "public-api"
    });
  });

  it("accepts a valid JWT on a jwt route without an API key", async () => {
    const { app } = await createTestApp();
    appsToClose.push(() => app.close());
    const token = await signTestJwt();

    const response = await app.inject({
      method: "GET",
      url: "/jwt",
      headers: { authorization: `Bearer ${token}` }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      identityType: "jwt"
    });
  });

  it("accepts a valid API key on an api_key route", async () => {
    const { app } = await createTestApp();
    appsToClose.push(() => app.close());

    const response = await app.inject({
      method: "GET",
      url: "/api-key",
      headers: { "x-api-key": "raw-client-key-1" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      identityType: "api_key"
    });
  });

  it("rejects missing unique_user_id by default", async () => {
    const { app } = await createTestApp();
    appsToClose.push(() => app.close());
    const token = await signTestJwt({ unique_user_id: undefined });

    const response = await app.inject({
      method: "GET",
      url: "/jwt",
      headers: { authorization: `Bearer ${token}` }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "unauthorized" });
  });

  it("blocks a JWT tied to a disabled organization", async () => {
    const { app } = await createTestApp();
    appsToClose.push(() => app.close());
    const token = await signTestJwt({ org_id: "org-disabled" });

    const response = await app.inject({
      method: "GET",
      url: "/jwt",
      headers: { authorization: `Bearer ${token}` }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "forbidden" });
  });

  it("denies JWT and API key mismatch on authenticated routes", async () => {
    const { app } = await createTestApp();
    appsToClose.push(() => app.close());
    const token = await signTestJwt({ unique_user_id: "user-1" });

    const response = await app.inject({
      method: "GET",
      url: "/authed",
      headers: {
        authorization: `Bearer ${token}`,
        "x-api-key": "raw-client-key-2"
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "forbidden" });
  });

  it("prefers JWT as the primary identity when both valid credentials match", async () => {
    const { app } = await createTestApp({
      apiKeys: {
        headerName: "x-api-key",
        clients: [
          {
            id: "client-1",
            name: "Client One",
            organizationId: "org-active",
            userId: "user-1",
            keyHash: hashApiKey("raw-client-key-1"),
            scopes: ["time:read"],
            enabled: true
          }
        ]
      }
    });
    appsToClose.push(() => app.close());
    const token = await signTestJwt({ unique_user_id: "user-1", sub: "user-1" });

    const response = await app.inject({
      method: "GET",
      url: "/authed",
      headers: {
        authorization: `Bearer ${token}`,
        "x-api-key": "raw-client-key-1"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      identityType: "jwt",
      subject: "user-1"
    });
  });

  it("applies longest-prefix policy selection", async () => {
    const { app } = await createTestApp();
    appsToClose.push(() => app.close());

    const response = await app.inject({
      method: "GET",
      url: "/policies/long/value"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      policyId: "nested-long"
    });
  });

  it("enforces optional route scopes when configured", async () => {
    const { app } = await createTestApp();
    appsToClose.push(() => app.close());
    const token = await signTestJwt({ scope: "time:read" });

    const response = await app.inject({
      method: "GET",
      url: "/scoped",
      headers: { authorization: `Bearer ${token}` }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "forbidden" });
  });

  it("upgrades public routes when a valid JWT is present", async () => {
    const { app } = await createTestApp();
    appsToClose.push(() => app.close());
    const token = await signTestJwt();

    const response = await app.inject({
      method: "GET",
      url: "/api",
      headers: { authorization: `Bearer ${token}` }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      identityType: "jwt",
      policyId: "public-api"
    });
  });

  it("returns specific auth codes for missing JWT and missing API key", async () => {
    const { app } = await createTestApp();
    appsToClose.push(() => app.close());

    const jwtRequired = await app.inject({ method: "GET", url: "/jwt" });
    const apiKeyRequired = await app.inject({ method: "GET", url: "/api-key" });

    expect(jwtRequired.statusCode).toBe(401);
    expect(apiKeyRequired.statusCode).toBe(401);
  });

  it("returns unauthorized for invalid presented credentials", async () => {
    const { app } = await createTestApp();
    appsToClose.push(() => app.close());

    const badJwt = await app.inject({
      method: "GET",
      url: "/jwt",
      headers: { authorization: "Bearer not-a-real-token" }
    });
    const badApiKey = await app.inject({
      method: "GET",
      url: "/api-key",
      headers: { "x-api-key": "nope" }
    });

    expect(badJwt.statusCode).toBe(401);
    expect(badApiKey.statusCode).toBe(401);
  });

  it("can allow a missing secondary identifier when configured", async () => {
    const { app } = await createTestApp({
      identityContext: {
        source: "jwt_claim",
        claim: "unique_user_id",
        required: false,
        globalUniqueness: "global"
      },
      behavior: {
        onMissingSecondaryIdentifier: "allow",
        onCredentialMismatch: "deny",
        onDisabledOrganization: "block"
      }
    });
    appsToClose.push(() => app.close());
    const token = await signTestJwt({ unique_user_id: undefined });

    const response = await app.inject({
      method: "GET",
      url: "/jwt",
      headers: { authorization: `Bearer ${token}` }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ identityType: "jwt" });
  });

  it("can prefer JWT on credential mismatch when configured", async () => {
    const { app } = await createTestApp({
      behavior: {
        onMissingSecondaryIdentifier: "reject",
        onCredentialMismatch: "prefer_jwt",
        onDisabledOrganization: "block"
      }
    });
    appsToClose.push(() => app.close());
    const token = await signTestJwt({ unique_user_id: "user-1" });

    const response = await app.inject({
      method: "GET",
      url: "/authed",
      headers: {
        authorization: `Bearer ${token}`,
        "x-api-key": "raw-client-key-2"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      identityType: "jwt"
    });
  });

  it("can allow disabled organizations when configured", async () => {
    const { app } = await createTestApp({
      behavior: {
        onMissingSecondaryIdentifier: "reject",
        onCredentialMismatch: "deny",
        onDisabledOrganization: "allow"
      }
    });
    appsToClose.push(() => app.close());
    const token = await signTestJwt({ org_id: "org-disabled" });

    const response = await app.inject({
      method: "GET",
      url: "/jwt",
      headers: { authorization: `Bearer ${token}` }
    });

    expect(response.statusCode).toBe(200);
  });

  it("accepts a valid JWKS token on a jwt route", async () => {
    const jwks = await createJwksTestServer();
    appsToClose.push(() => jwks.close());
    const signingKey = await jwks.createSigningKey("kid-1");
    jwks.publishKeys([signingKey]);

    const { app } = await createTestApp({
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
    });
    appsToClose.push(() => app.close());

    const token = await jwks.signJwt(signingKey);
    const response = await app.inject({
      method: "GET",
      url: "/jwt",
      headers: { authorization: `Bearer ${token}` }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      identityType: "jwt"
    });
  });

  it("rejects JWKS tokens with missing kid, bad alg, wrong audience, wrong issuer, and disabled issuers", async () => {
    const jwks = await createJwksTestServer();
    appsToClose.push(() => jwks.close());
    const signingKey = await jwks.createSigningKey("kid-1");
    jwks.publishKeys([signingKey]);

    const baseIssuer = {
      issuer: jwks.issuer,
      audiences: [jwks.audience],
      verificationMode: "jwks" as const,
      jwksUrl: jwks.jwksUrl,
      allowedAlgorithms: ["RS256"],
      cacheTtlMs: 1_000,
      requestTimeoutMs: 1_000,
      organizationClaim: "org_id",
      subjectClaim: "sub",
      requiredClaims: ["iss", "aud", "exp", "sub", "unique_user_id"],
      optionalClaims: ["scope"]
    };

    const { app: missingKidApp } = await createTestApp({
      jwt: { cookieName: "opengate_test_jwt", issuers: [baseIssuer] }
    });
    appsToClose.push(() => missingKidApp.close());

    const missingKidToken = await jwks.signJwt(signingKey, {}, { includeKid: false });
    const missingKidResponse = await missingKidApp.inject({
      method: "GET",
      url: "/jwt",
      headers: { authorization: `Bearer ${missingKidToken}` }
    });
    expect(missingKidResponse.statusCode).toBe(401);

    const { app: badAlgApp } = await createTestApp({
      jwt: {
        cookieName: "opengate_test_jwt",
        issuers: [
          {
            ...baseIssuer,
            allowedAlgorithms: ["PS256"]
          }
        ]
      }
    });
    appsToClose.push(() => badAlgApp.close());

    const badAlgToken = await jwks.signJwt(signingKey);
    const badAlgResponse = await badAlgApp.inject({
      method: "GET",
      url: "/jwt",
      headers: { authorization: `Bearer ${badAlgToken}` }
    });
    expect(badAlgResponse.statusCode).toBe(401);

    const { app: wrongAudienceApp } = await createTestApp({
      jwt: { cookieName: "opengate_test_jwt", issuers: [baseIssuer] }
    });
    appsToClose.push(() => wrongAudienceApp.close());

    const wrongAudienceToken = await jwks.signJwt(signingKey, { aud: "other-audience" });
    const wrongAudienceResponse = await wrongAudienceApp.inject({
      method: "GET",
      url: "/jwt",
      headers: { authorization: `Bearer ${wrongAudienceToken}` }
    });
    expect(wrongAudienceResponse.statusCode).toBe(401);

    const wrongIssuerToken = await jwks.signJwt(signingKey, { iss: "https://different-issuer.test" });
    const wrongIssuerResponse = await wrongAudienceApp.inject({
      method: "GET",
      url: "/jwt",
      headers: { authorization: `Bearer ${wrongIssuerToken}` }
    });
    expect(wrongIssuerResponse.statusCode).toBe(401);

    const { app: disabledIssuerApp } = await createTestApp({
      jwt: {
        cookieName: "opengate_test_jwt",
        issuers: [
          {
            ...baseIssuer,
            enabled: false
          }
        ]
      }
    });
    appsToClose.push(() => disabledIssuerApp.close());

    const disabledIssuerToken = await jwks.signJwt(signingKey);
    const disabledIssuerResponse = await disabledIssuerApp.inject({
      method: "GET",
      url: "/jwt",
      headers: { authorization: `Bearer ${disabledIssuerToken}` }
    });
    expect(disabledIssuerResponse.statusCode).toBe(403);
    expect(disabledIssuerResponse.json()).toEqual({ error: "forbidden" });
  });

  it("refreshes JWKS on unknown kid and accepts a rotated key", async () => {
    const jwks = await createJwksTestServer();
    appsToClose.push(() => jwks.close());
    const key1 = await jwks.createSigningKey("kid-1");
    const key2 = await jwks.createSigningKey("kid-2");
    jwks.publishKeys([key1]);

    const { app } = await createTestApp({
      jwt: {
        cookieName: "opengate_test_jwt",
        issuers: [
          {
            issuer: jwks.issuer,
            audiences: [jwks.audience],
            verificationMode: "jwks",
            jwksUrl: jwks.jwksUrl,
            allowedAlgorithms: ["RS256"],
            cacheTtlMs: 60_000,
            requestTimeoutMs: 1_000,
            organizationClaim: "org_id",
            subjectClaim: "sub",
            requiredClaims: ["iss", "aud", "exp", "sub", "unique_user_id"],
            optionalClaims: ["scope"]
          }
        ]
      }
    });
    appsToClose.push(() => app.close());

    const token1 = await jwks.signJwt(key1);
    const firstResponse = await app.inject({
      method: "GET",
      url: "/jwt",
      headers: { authorization: `Bearer ${token1}` }
    });
    expect(firstResponse.statusCode).toBe(200);

    jwks.publishKeys([key1, key2]);
    const token2 = await jwks.signJwt(key2);
    const secondResponse = await app.inject({
      method: "GET",
      url: "/jwt",
      headers: { authorization: `Bearer ${token2}` }
    });
    expect(secondResponse.statusCode).toBe(200);
  });

  it("stops accepting a removed JWKS key after cache refresh", async () => {
    const jwks = await createJwksTestServer();
    appsToClose.push(() => jwks.close());
    const key1 = await jwks.createSigningKey("kid-1");
    const key2 = await jwks.createSigningKey("kid-2");
    jwks.publishKeys([key1, key2]);

    const { app } = await createTestApp({
      jwt: {
        cookieName: "opengate_test_jwt",
        issuers: [
          {
            issuer: jwks.issuer,
            audiences: [jwks.audience],
            verificationMode: "jwks",
            jwksUrl: jwks.jwksUrl,
            allowedAlgorithms: ["RS256"],
            cacheTtlMs: 5,
            requestTimeoutMs: 1_000,
            organizationClaim: "org_id",
            subjectClaim: "sub",
            requiredClaims: ["iss", "aud", "exp", "sub", "unique_user_id"],
            optionalClaims: ["scope"]
          }
        ]
      }
    });
    appsToClose.push(() => app.close());

    const token = await jwks.signJwt(key1);
    const firstResponse = await app.inject({
      method: "GET",
      url: "/jwt",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(firstResponse.statusCode).toBe(200);

    jwks.publishKeys([key2]);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const secondResponse = await app.inject({
      method: "GET",
      url: "/jwt",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(secondResponse.statusCode).toBe(401);
    expect(secondResponse.json()).toEqual({ error: "unauthorized" });
  });
});

describe("rate limiting", () => {
  it("limits anonymous requests by IP", async () => {
    const { app } = await createTestApp({
      rateLimits: {
        timezone: "UTC",
        store: "memory",
        free: { points: 1, duration: "calendar_day" },
        upgraded: { points: 1000, duration: "calendar_day" }
      }
    });
    appsToClose.push(() => app.close());

    const first = await app.inject({ method: "GET", url: "/api", remoteAddress: "10.0.0.6" });
    const second = await app.inject({ method: "GET", url: "/api", remoteAddress: "10.0.0.6" });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
    expect(second.json()).toEqual({ error: "rate limited" });
  });

  it("limits upgraded JWT traffic by resolved identity instead of IP", async () => {
    const { app } = await createTestApp({
      rateLimits: {
        timezone: "UTC",
        store: "memory",
        free: { points: 10, duration: "calendar_day" },
        upgraded: { points: 1, duration: "calendar_day" }
      }
    });
    appsToClose.push(() => app.close());
    const token = await signTestJwt();

    const first = await app.inject({
      method: "GET",
      url: "/jwt",
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: "10.0.0.1"
    });
    const second = await app.inject({
      method: "GET",
      url: "/jwt",
      headers: { authorization: `Bearer ${token}` },
      remoteAddress: "10.0.0.2"
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
  });

  it("keeps upgraded API-key limits independent per key", async () => {
    const { app } = await createTestApp({
      rateLimits: {
        timezone: "UTC",
        store: "memory",
        free: { points: 10, duration: "calendar_day" },
        upgraded: { points: 1, duration: "calendar_day" }
      }
    });
    appsToClose.push(() => app.close());

    const first = await app.inject({
      method: "GET",
      url: "/api-key",
      headers: { "x-api-key": "raw-client-key-1" }
    });
    const second = await app.inject({
      method: "GET",
      url: "/api-key",
      headers: { "x-api-key": "raw-client-key-2" }
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
  });

  it("accepts multiple active API-key versions during a rotation overlap", async () => {
    const { app } = await createTestApp({
      apiKeys: {
        headerName: "x-api-key",
        clients: [
          {
            id: "client-rotation",
            name: "Rotating Client",
            organizationId: "org-active",
            userId: "user-rotation",
            keyVersions: [
              {
                id: "key-v1",
                keyHash: hashApiKey("rotating-key-v1"),
                createdAt: "2026-03-01T00:00:00.000Z",
                enabled: true
              },
              {
                id: "key-v2",
                keyHash: hashApiKey("rotating-key-v2"),
                createdAt: "2026-03-15T00:00:00.000Z",
                enabled: true
              }
            ],
            scopes: ["time:read"],
            enabled: true
          }
        ]
      }
    });
    appsToClose.push(() => app.close());

    const v1 = await app.inject({
      method: "GET",
      url: "/api-key",
      headers: { "x-api-key": "rotating-key-v1" }
    });
    const v2 = await app.inject({
      method: "GET",
      url: "/api-key",
      headers: { "x-api-key": "rotating-key-v2" }
    });

    expect(v1.statusCode).toBe(200);
    expect(v2.statusCode).toBe(200);
  });

  it("rejects revoked, expired, disabled, and not-yet-valid API-key versions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-25T00:00:00.000Z"));

    const { app } = await createTestApp({
      apiKeys: {
        headerName: "x-api-key",
        clients: [
          {
            id: "client-rotation",
            name: "Rotating Client",
            organizationId: "org-active",
            userId: "user-rotation",
            keyVersions: [
              {
                id: "revoked-key",
                keyHash: hashApiKey("revoked-key"),
                createdAt: "2026-03-01T00:00:00.000Z",
                revokedAt: "2026-03-20T00:00:00.000Z",
                enabled: true
              },
              {
                id: "expired-key",
                keyHash: hashApiKey("expired-key"),
                createdAt: "2026-03-01T00:00:00.000Z",
                expiresAt: "2026-03-20T00:00:00.000Z",
                enabled: true
              },
              {
                id: "disabled-key",
                keyHash: hashApiKey("disabled-key"),
                createdAt: "2026-03-01T00:00:00.000Z",
                enabled: false
              },
              {
                id: "future-key",
                keyHash: hashApiKey("future-key"),
                createdAt: "2026-03-01T00:00:00.000Z",
                notBefore: "2026-04-01T00:00:00.000Z",
                enabled: true
              }
            ],
            scopes: ["time:read"],
            enabled: true
          }
        ]
      }
    });
    appsToClose.push(() => app.close());

    for (const rawKey of ["revoked-key", "expired-key", "disabled-key", "future-key"]) {
      const response = await app.inject({
        method: "GET",
        url: "/api-key",
        headers: { "x-api-key": rawKey }
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "unauthorized" });
    }
  });

  it("computes calendar-day buckets using timezone and UTC default", () => {
    const date = new Date("2026-03-25T23:30:00.000Z");

    expect(getCalendarDayBucket(date, "UTC")).toBe("2026-03-25");
    expect(getCalendarDayBucket(date, "Asia/Manila")).toBe("2026-03-26");
  });

  it("supports organization-scoped uniqueness when configured", async () => {
    const store = createRateLimitStore(createTestConfig());
    const config = createTestConfig({
      identityContext: {
        source: "jwt_claim",
        claim: "unique_user_id",
        required: true,
        globalUniqueness: "organization"
      },
      rateLimits: {
        timezone: "UTC",
        store: "memory",
        free: { points: 10, duration: "calendar_day" },
        upgraded: { points: 1, duration: "calendar_day" }
      }
    });

    const first = await consumeRateLimit(store, config, {
      identityType: "jwt",
      tier: "upgraded",
      organizationId: "org-a",
      subject: "sub-a",
      secondaryIdentifier: "same-user",
      scopes: [],
      rateLimitSubject: "jwt:org-a:same-user",
      jwtClaims: {},
      issuer: "issuer"
    });
    const second = await consumeRateLimit(store, config, {
      identityType: "jwt",
      tier: "upgraded",
      organizationId: "org-b",
      subject: "sub-b",
      secondaryIdentifier: "same-user",
      scopes: [],
      rateLimitSubject: "jwt:org-b:same-user",
      jwtClaims: {},
      issuer: "issuer"
    });

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
  });

  it("rejects unsupported duration values at runtime", async () => {
    const store = createRateLimitStore(createTestConfig());
    const invalidConfig = {
      ...createTestConfig(),
      rateLimits: {
        timezone: "UTC",
        store: "memory",
        free: { points: 10, duration: "rolling_window" },
        upgraded: { points: 5, duration: "calendar_day" }
      }
    } as never;

    await expect(consumeRateLimit(store, invalidConfig, {
      identityType: "anonymous",
      tier: "free",
      scopes: [],
      rateLimitSubject: "127.0.0.1"
    })).rejects.toThrow("Unsupported rate limit duration");
  });
});

describe("audit logging", () => {
  it("writes audit rows for allowed and blocked requests with claim snapshots", async () => {
    const auditPath = path.join(process.cwd(), ".tmp-audit-allowed.sqlite");
    const { app } = await createTestApp({
      audit: {
        enabled: true,
        sqlitePath: auditPath,
        jwtClaimSnapshot: ["iss", "aud", "sub", "org_id", "unique_user_id"]
      }
    });
    try {
      const token = await signTestJwt();
      await app.inject({
        method: "GET",
        url: "/jwt",
        headers: { authorization: `Bearer ${token}` }
      });
      await app.inject({
        method: "GET",
        url: "/jwt"
      });
    } finally {
      await app.close();
    }

    const rows = readAuditRows(auditPath);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.route_policy_id).toBe("jwt-api");
    expect(rows[0]?.identity_type).toBe("jwt");
    expect(rows[0]?.outcome).toBe("allowed");
    expect(rows[1]?.outcome).toBe("blocked");
    expect(rows[1]?.block_reason).toBe("jwt_required");
    expect(JSON.parse(rows[0]?.jwt_claim_snapshot ?? "{}")).toMatchObject({
      iss: "test-issuer",
      aud: "test-audience",
      sub: "user-1",
      org_id: "org-active",
      unique_user_id: "user-1"
    });
    if (fs.existsSync(auditPath)) {
      fs.unlinkSync(auditPath);
    }
  });

  it("stores only approved JWT claims in audit snapshots", async () => {
    const auditPath = path.join(process.cwd(), ".tmp-audit-redaction.sqlite");
    const { app } = await createTestApp({
      audit: {
        enabled: true,
        sqlitePath: auditPath,
        jwtClaimSnapshot: ["iss", "aud", "sub"]
      }
    });
    try {
      const token = await signTestJwt({
        display_name: "Ava",
        unique_user_id: "user-1"
      });

      await app.inject({
        method: "GET",
        url: "/jwt",
        headers: { authorization: `Bearer ${token}` }
      });
    } finally {
      await app.close();
    }

    const rows = readAuditRows(auditPath);
    const snapshot = JSON.parse(rows[0]?.jwt_claim_snapshot ?? "{}");

    expect(snapshot).toEqual({
      iss: "test-issuer",
      aud: "test-audience",
      sub: "user-1"
    });
    expect(snapshot.display_name).toBeUndefined();
    expect(snapshot.unique_user_id).toBeUndefined();
    if (fs.existsSync(auditPath)) {
      fs.unlinkSync(auditPath);
    }
  });

  it("keeps audit rows append-only across repeated allowed requests", async () => {
    const auditPath = path.join(process.cwd(), ".tmp-audit-append.sqlite");
    const { app } = await createTestApp({
      audit: {
        enabled: true,
        sqlitePath: auditPath,
        jwtClaimSnapshot: ["iss", "aud", "sub", "org_id", "unique_user_id"]
      }
    });
    try {
      await app.inject({ method: "GET", url: "/api", remoteAddress: "10.0.0.7" });
      await app.inject({ method: "GET", url: "/api", remoteAddress: "10.0.0.8" });
    } finally {
      await app.close();
    }

    const rows = readAuditRows(auditPath);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.outcome).toBe("allowed");
    expect(rows[1]?.outcome).toBe("allowed");
    if (fs.existsSync(auditPath)) {
      fs.unlinkSync(auditPath);
    }
  });
});


