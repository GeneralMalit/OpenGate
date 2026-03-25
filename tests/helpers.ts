import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import Database from "better-sqlite3";
import cookie from "@fastify/cookie";
import { SignJWT } from "jose";
import { createOpenGate, hashApiKey } from "../src/index.js";
import type { OpenGateConfig } from "../src/lib/types.js";

export function createTestConfig(overrides: Partial<OpenGateConfig> = {}): OpenGateConfig {
  const base: OpenGateConfig = {
    organizations: [
      { id: "org-active", name: "Active Org", enabled: true },
      { id: "org-disabled", name: "Disabled Org", enabled: false }
    ],
    jwt: {
      cookieName: "opengate_test_jwt",
      issuers: [
        {
          issuer: "test-issuer",
          audiences: ["test-audience"],
          sharedSecret: "test-shared-secret",
          organizationClaim: "org_id",
          subjectClaim: "sub",
          requiredClaims: ["iss", "aud", "exp", "sub", "unique_user_id"],
          optionalClaims: ["scope"]
        }
      ]
    },
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
        },
        {
          id: "client-2",
          name: "Client Two",
          organizationId: "org-active",
          userId: "user-2",
          keyHash: hashApiKey("raw-client-key-2"),
          scopes: ["time:read"],
          enabled: true
        }
      ]
    },
    identityContext: {
      source: "jwt_claim",
      claim: "unique_user_id",
      required: true,
      globalUniqueness: "global"
    },
    routePolicies: [
      { id: "public-api", pathPrefix: "/api", accessMode: "public", requiredScopes: [], enabled: true },
      { id: "authenticated-api", pathPrefix: "/authed", accessMode: "authenticated", requiredScopes: [], enabled: true },
      { id: "jwt-api", pathPrefix: "/jwt", accessMode: "jwt", requiredScopes: [], enabled: true },
      { id: "api-key-api", pathPrefix: "/api-key", accessMode: "api_key", requiredScopes: [], enabled: true },
      { id: "scoped-api", pathPrefix: "/scoped", accessMode: "jwt", requiredScopes: ["admin:read"], enabled: true },
      { id: "nested-short", pathPrefix: "/policies", accessMode: "public", requiredScopes: [], enabled: true },
      { id: "nested-long", pathPrefix: "/policies/long", accessMode: "public", requiredScopes: [], enabled: true }
    ],
    rateLimits: {
      timezone: "UTC",
      store: "memory",
      free: { points: 10, duration: "calendar_day" },
      upgraded: { points: 1000, duration: "calendar_day" }
    },
    audit: {
      enabled: true,
      sqlitePath: path.join(os.tmpdir(), `opengate-${Date.now()}-${Math.random()}.sqlite`),
      jwtClaimSnapshot: ["iss", "aud", "sub", "org_id", "unique_user_id"]
    },
    behavior: {
      onMissingSecondaryIdentifier: "reject",
      onCredentialMismatch: "deny",
      onDisabledOrganization: "block"
    }
  };

  return {
    ...base,
    ...overrides,
    jwt: {
      ...base.jwt,
      ...overrides.jwt,
      issuers: overrides.jwt?.issuers ?? base.jwt.issuers
    },
    apiKeys: {
      ...base.apiKeys,
      ...overrides.apiKeys,
      clients: overrides.apiKeys?.clients ?? base.apiKeys.clients
    },
    identityContext: {
      ...base.identityContext,
      ...overrides.identityContext
    },
    rateLimits: {
      ...base.rateLimits,
      ...overrides.rateLimits,
      free: overrides.rateLimits?.free ?? base.rateLimits.free,
      upgraded: overrides.rateLimits?.upgraded ?? base.rateLimits.upgraded
    },
    audit: {
      ...base.audit,
      ...overrides.audit
    },
    behavior: {
      ...base.behavior,
      ...overrides.behavior
    },
    organizations: overrides.organizations ?? base.organizations,
    routePolicies: overrides.routePolicies ?? base.routePolicies
  };
}

export async function createTestApp(configOverrides: Partial<OpenGateConfig> = {}) {
  const config = createTestConfig(configOverrides);
  const gate = createOpenGate(config);
  const app = Fastify({ logger: false });
  await app.register(cookie);

  gate.registerProtectedRoute(app, {
    path: "/api",
    method: "GET",
    handler: async (request) => ({
      ok: true,
      identityType: request.opengate?.identity.identityType,
      policyId: request.opengate?.routePolicy.id
    })
  });

  gate.registerProtectedRoute(app, {
    path: "/jwt",
    method: "GET",
    handler: async (request) => ({
      ok: true,
      identityType: request.opengate?.identity.identityType
    })
  });

  gate.registerProtectedRoute(app, {
    path: "/api-key",
    method: "GET",
    handler: async (request) => ({
      ok: true,
      identityType: request.opengate?.identity.identityType
    })
  });

  gate.registerProtectedRoute(app, {
    path: "/authed",
    method: "GET",
    handler: async (request) => {
      const identity = request.opengate?.identity;

      return {
        ok: true,
        identityType: identity?.identityType,
        subject:
          identity && "subject" in identity
            ? identity.subject
            : null
      };
    }
  });

  gate.registerProtectedRoute(app, {
    path: "/scoped",
    method: "GET",
    handler: async () => ({ ok: true })
  });

  gate.registerProtectedRoute(app, {
    path: "/policies/long/value",
    method: "GET",
    handler: async (request) => ({
      ok: true,
      policyId: request.opengate?.routePolicy.id
    })
  });

  app.addHook("onClose", (_instance, done) => {
    gate.close();
    done();
  });

  return { app, config };
}

export async function signTestJwt(overrides: Record<string, unknown> = {}) {
  const config = createTestConfig();
  const issuerConfig = config.jwt.issuers[0];

  return new SignJWT({
    sub: "user-1",
    org_id: "org-active",
    unique_user_id: "user-1",
    scope: "time:read admin:read",
    ...overrides
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer((overrides.iss as string | undefined) ?? issuerConfig.issuer)
    .setAudience((overrides.aud as string | undefined) ?? issuerConfig.audiences[0])
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(issuerConfig.sharedSecret));
}

export type AuditRow = {
  route_policy_id: string;
  identity_type: string;
  outcome: string;
  block_reason: string | null;
  jwt_claim_snapshot: string | null;
};

export function readAuditRows(sqlitePath: string): AuditRow[] {
  const db = new Database(sqlitePath, { readonly: true });
  const rows = db.prepare("SELECT * FROM audit_events ORDER BY id ASC").all() as AuditRow[];
  db.close();
  return rows;
}
