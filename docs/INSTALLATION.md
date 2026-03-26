# OpenGate Installation Guide

This guide covers how to wire OpenGate into your own Fastify or Express endpoint.

The README gives the overview. This page gives the setup.

## Framework Matrix

OpenGate now ships with two adapter packages:

| Framework | Install path | Best fit |
| --- | --- | --- |
| Fastify | `opengate` + `@opengate/fastify` | current canonical example and the smallest compatibility path |
| Express | `opengate` + `@opengate/express` | existing Express services that want the same config and policy model |

Both adapters use the same JSON config file, route policy model, and audit/rate-limit behavior.

## What You Need

Before OpenGate can protect an endpoint, you need:
- a Fastify server
- one route you want OpenGate to sit in front of
- a local `opengate.config.json`
- a JWT issuer if you want JWT-based upgraded access
- API keys if you want API-key-based upgraded access
- a writable SQLite file path for audit logs

If you are using the repository locally while developing, keep OpenGate in the same workspace and import it from the local source. If you are wiring this into another service, treat OpenGate like a normal library dependency in that service.

The starter flow now lives in the CLI:

```bash
npm run cli -- init --template website
npm run cli -- init --template api
npm run cli -- init --template partner
```

## Config Layout

The MVP config is JSON. Each top-level section has one job:

| Section | Purpose |
| --- | --- |
| `organizations` | Declares the enabled or disabled organizations that requests map to. |
| `jwt` | Defines trusted JWT issuers, audiences, shared secret(s), and required claims. |
| `apiKeys` | Defines the API-key header and the hashed API-key clients OpenGate accepts. |
| `identityContext` | Declares the secondary identity claim used for upgraded access. |
| `routePolicies` | Maps path prefixes to access modes and required scopes. |
| `rateLimits` | Sets tier limits, calendar-day resets, and the rate-limit store choice. |
| `audit` | Enables SQLite logging and controls which JWT claims are copied into audit rows. |
| `observability` | Overrides the request-id header and the built-in health, readiness, metrics, and status paths. |
| `behavior` | Controls the default deny/block behavior for mismatches or missing identity fields. |

The important defaults in the MVP are:
- `org_id` for the organization claim
- `unique_user_id` for the secondary identity claim
- `UTC` for calendar-day resets
- in-memory rate limiting by default
- SQLite audit logging
- shared-secret JWT verification for demo mode

Production Phase 1 adds:
- remote `jwks` JWT issuers
- issuer enable/disable controls
- versioned API-key rotation
- validated audit claim allowlists

Phase 4 adds explicit scale-out choices:
- `rateLimits.store: "redis"` for shared rate-limit counters across nodes
- `audit.backend: "postgres"` for durable audit writes beyond SQLite
- buffered audit tuning with `audit.flushIntervalMs`, `audit.batchSize`, and `audit.maxQueueSize`
- keeping `memory` and SQLite as the default single-node path

Phase 5 adds operational visibility:
- request IDs on every request context and audit row
- built-in `/healthz`, `/readyz`, `/metrics`, and `/status` routes
- structured request logs through a pluggable logger adapter

Phase 6 adds a lightweight control plane:
- `createControlPlane("./opengate.config.json")` for file-backed, JSON-based management in-process
- `registerControlPlaneRoutes(app, gate, controlPlane)` for protected admin routes using the existing auth model
- CLI commands such as `opengate control list users`, `opengate control issue api-key`, and `opengate control simulate`
- JSON export/import plus request simulation against the current config before a rollout
- a lightweight protected `/admin` page in the example apps for the common control-plane workflows

## Step 1 - Create The Config

Start with a demo/shared-secret config like this:

```json
{
  "organizations": [
    {
      "id": "acme",
      "name": "Acme Inc",
      "enabled": true
    }
  ],
  "jwt": {
    "cookieName": "opengate_jwt",
    "issuers": [
      {
        "issuer": "your-auth-service",
        "audiences": ["your-api"],
        "enabled": true,
        "verificationMode": "shared_secret",
        "sharedSecret": "replace-this-in-production",
        "organizationClaim": "org_id",
        "subjectClaim": "sub",
        "requiredClaims": ["iss", "aud", "exp", "sub", "unique_user_id"],
        "optionalClaims": ["scope"]
      }
    ]
  },
  "apiKeys": {
    "headerName": "x-api-key",
    "clients": [
      {
        "id": "client-1",
        "name": "Partner Client",
        "organizationId": "acme",
        "userId": "partner-user-1",
        "keyVersions": [
          {
            "id": "client-1-primary",
            "keyHash": "sha256-hash-goes-here",
            "createdAt": "2026-03-25T00:00:00.000Z",
            "enabled": true
          }
        ],
        "scopes": ["time:read"],
        "enabled": true
      }
    ]
  },
  "identityContext": {
    "source": "jwt_claim",
    "claim": "unique_user_id",
    "required": true,
    "globalUniqueness": "global"
  },
  "routePolicies": [
    {
      "id": "time-api",
      "pathPrefix": "/api/time",
      "accessMode": "public",
      "requiredScopes": [],
      "enabled": true
    }
  ],
  "rateLimits": {
    "timezone": "UTC",
    "store": "memory",
    "free": {
      "points": 10,
      "duration": "calendar_day"
    },
    "upgraded": {
      "points": 1000,
      "duration": "calendar_day"
    }
  },
  "audit": {
    "enabled": true,
    "sqlitePath": "./data/opengate.db",
    "jwtClaimSnapshot": ["iss", "aud", "sub", "org_id", "unique_user_id"]
  },
  "behavior": {
    "onMissingSecondaryIdentifier": "reject",
    "onCredentialMismatch": "deny",
    "onDisabledOrganization": "block"
  }
}
```

Legacy configs that still use `sharedSecret` without `verificationMode`, or `keyHash` without `keyVersions`, still load. OpenGate normalizes those legacy shapes internally so you can migrate incrementally.

For production, switch the issuer to `jwks` mode:

```json
{
  "issuer": "https://your-issuer.example.com/",
  "audiences": ["your-api"],
  "enabled": true,
  "verificationMode": "jwks",
  "jwksUrl": "https://your-issuer.example.com/.well-known/jwks.json",
  "allowedAlgorithms": ["RS256"],
  "cacheTtlMs": 300000,
  "requestTimeoutMs": 5000,
  "organizationClaim": "org_id",
  "subjectClaim": "sub",
  "requiredClaims": ["iss", "aud", "exp", "sub", "unique_user_id"],
  "optionalClaims": ["scope"]
}
```

Auth0 example:

```json
{
  "issuer": "https://your-tenant.us.auth0.com/",
  "audiences": ["https://api.your-company.com"],
  "enabled": true,
  "verificationMode": "jwks",
  "jwksUrl": "https://your-tenant.us.auth0.com/.well-known/jwks.json",
  "allowedAlgorithms": ["RS256"],
  "cacheTtlMs": 300000,
  "requestTimeoutMs": 5000,
  "organizationClaim": "org_id",
  "subjectClaim": "sub",
  "requiredClaims": ["iss", "aud", "exp", "sub", "unique_user_id"],
  "optionalClaims": ["scope"]
}
```

If you only need a public route at first, keep the route policy `accessMode` at `public`. If you want logged-in users, switch the route to `authenticated` or `jwt`. If you want server-to-server access, use `api_key`.

## Step 1b - Use The Starter CLI

If you want OpenGate to scaffold a working starting point for you, use the CLI:

```bash
npm run cli -- init --route mixed
```

Route modes you can generate:

| Route mode | Generated access mode | Good for |
| --- | --- | --- |
| `public` | `public` | a public endpoint that can still upgrade when credentials are present |
| `jwt` | `jwt` | a logged-in user flow with JWT-only protection |
| `api_key` | `api_key` | a server-to-server or partner API-key flow |
| `mixed` | `authenticated` | a route that accepts either JWT or API key credentials |

The starter output includes:
- `opengate.config.json`
- `server.ts`
- `DEMO-CREDENTIALS.md`
- `data/audit-sample.json`

Use `opengate validate` to check a config in plain language and `opengate migrate` to normalize older config shapes into the current versioned format.

## Step 2 - Hash API Keys

Never store raw API keys in config.

Use the library helper:

```ts
import { hashApiKey } from "opengate";

const keyHash = hashApiKey("your-raw-api-key");
```

For a single active key, store the hash in one `keyVersions[]` entry. During rotation, add a second active version and retire the first one later.

At runtime, OpenGate hashes the presented header value and compares hashes. The raw key itself is never used as the stored secret.

Phase 1 key-version fields:
- `notBefore`: key becomes valid at this time
- `expiresAt`: key stops being valid at this time
- `revokedAt`: key is revoked from this time forward
- `enabled`: emergency off switch for that key version

Example rotation window:

```json
{
  "id": "client-1",
  "name": "Partner Client",
  "organizationId": "acme",
  "userId": "partner-user-1",
  "keyVersions": [
    {
      "id": "client-1-v1",
      "keyHash": "old-hash",
      "createdAt": "2026-03-01T00:00:00.000Z",
      "expiresAt": "2026-04-01T00:00:00.000Z",
      "enabled": true
    },
    {
      "id": "client-1-v2",
      "keyHash": "new-hash",
      "createdAt": "2026-03-20T00:00:00.000Z",
      "notBefore": "2026-03-20T00:00:00.000Z",
      "enabled": true
    }
  ],
  "scopes": ["time:read"],
  "enabled": true
}
```

## Step 3 - Register A Route Through OpenGate

OpenGate is meant to sit in front of an existing handler.

Fastify:

```ts
import Fastify from "fastify";
import { createOpenGate } from "opengate";

const app = Fastify();
const gate = createOpenGate("./opengate.config.json");

gate.registerProtectedRoute(app, {
  path: "/api/time",
  method: "GET",
  handler: async (request) => {
    const upgraded = request.opengate?.identity.identityType !== "anonymous";

    return {
      currentTime: new Date().toISOString(),
      status: "ok",
      ...(upgraded ? { paidTier: true } : {})
    };
  }
});
```

The handler is only reached after OpenGate resolves policy, identity, and rate-limit state.

Express uses the same route-config shape:

```ts
import express from "express";
import { createExpressOpenGate } from "opengate";

const app = express();
const gate = createExpressOpenGate("./opengate.config.json");

gate.registerProtectedRoute(app, {
  path: "/api/time",
  method: "GET",
  handler: async (request) => {
    const upgraded = request.opengate?.identity.identityType !== "anonymous";

    return {
      currentTime: new Date().toISOString(),
      status: "ok",
      ...(upgraded ? { paidTier: true } : {})
    };
  }
});
```

## Step 4 - Connect JWT Issuance

OpenGate verifies JWTs. It does not mint them for your application.

Each token should include:
- `iss`
- `aud`
- `exp`
- `sub`
- `unique_user_id`
- the organization claim, usually `org_id`

For demo/shared-secret mode, your issuer signs with the same shared secret OpenGate knows about.

For production/JWKS mode:
- your issuer publishes signing keys at the configured `jwksUrl`
- tokens should include a `kid`
- the header `alg` must be in `allowedAlgorithms`
- OpenGate caches the JWKS in process and refreshes once immediately when it sees an unknown `kid`

If you use a cookie-based login flow, register `@fastify/cookie` and set the token in an `HttpOnly` cookie. That is what the example app does.

If you use header-based JWTs, send `Authorization: Bearer <token>`.

## Step 5 - Decide How Identity Should Resolve

The MVP uses a secondary identity rule so upgraded access is not tied to a single loose JWT claim.

By default:
- the secondary claim is `unique_user_id`
- the claim is expected from the JWT
- missing values are rejected
- the value is treated as globally unique

If both JWT and API key are present, OpenGate expects them to match organization and user identity unless you explicitly change that behavior.

## Step 6 - Configure Audit Storage

Audit logging writes to SQLite by default when enabled. Make sure the configured path is writable by the host process.

The audit record includes:
- matched route policy
- identity type
- organization context
- method
- path
- status code
- latency
- outcome
- block reason
- filtered JWT claim snapshot

This is enough to answer the usual "what happened and why?" questions without dumping the full token into storage.

Phase 1 audit redaction rule:
- `audit.jwtClaimSnapshot` is a global allowlist
- only approved identity-related claims can be listed there
- unsupported claims are rejected at config-load time

### Scale-Out Storage

If you are deploying OpenGate on more than one node, switch the storage backends explicitly:

```json
{
  "rateLimits": {
    "store": "redis",
    "redisUrl": "redis://localhost:6379",
    "redisKeyPrefix": "opengate:rate-limit",
    "redisKeyExpirySeconds": 172800
  },
  "audit": {
    "enabled": true,
    "backend": "postgres",
    "postgresUrl": "postgres://opengate:secret@localhost:5432/opengate",
    "postgresTable": "audit_events",
    "flushIntervalMs": 50,
    "batchSize": 100,
    "maxQueueSize": 10000
  }
}
```

Operational guidance:
- keep the default `memory` store and SQLite backend for local development and single-node demos
- use Redis when you need shared rate limits across instances
- use Postgres when audit retention or multi-node durability matters
- configure retention outside the request path with a scheduled archive or prune job that matches your compliance policy
- tune the buffered audit queue if bursty traffic is likely, so logging does not become the bottleneck

## Step 7 - Verify The Integration

Once the endpoint is wired, test the basic flows in this order:

1. Anonymous request to a public route returns `200`.
2. Login or mint a JWT and confirm upgraded access returns the paid-tier response shape.
3. Send a bad JWT and confirm the request is rejected.
4. Send a valid API key to an API-key route and confirm it passes.
5. Send enough requests to trigger the configured tier limit and confirm `429`.
6. Check the SQLite audit file and confirm rows are written for both allowed and blocked requests.

## Step 8 - Add Operational Visibility

Once the endpoint works, wire the operational routes into the same app:

```ts
import { createConsoleLoggerAdapter, createOpenGate } from "opengate";

const gate = createOpenGate({
  configPath: "./opengate.config.json",
  logger: createConsoleLoggerAdapter()
});

gate.registerOperationalRoutes(app);
```

That gives you:
- `/healthz` for a cheap liveness check
- `/readyz` for readiness
- `/metrics` for request and backend counters
- `/status` for a read-only summary of the current backends and route metrics

The correlation ID defaults to `x-request-id`. If your platform uses a different header, set `observability.requestIdHeader` in the config file so the same ID shows up in logs and audit rows.

## Current MVP Limitations

The product deliberately keeps the surface area small:
- Fastify remains the canonical reference example
- Express is the first additional adapter
- in-memory rate limiting by default
- SQLite audit logging only
- no distributed JWKS cache yet

## Production Note

The demo flow uses shared-secret JWT verification because it is simple and easy to validate. That remains appropriate for local demos and tightly controlled environments.

For production, use `verificationMode: "jwks"` so OpenGate validates with rotating public keys instead of sharing the signing secret.

## Phase 7 Distribution

The current distribution shape is:

- root package: `opengate`
- adapter packages: `@opengate/fastify`, `@opengate/express`
- preferred starters: `website`, `api`, `partner`
- versioned docs: [docs-site](../docs-site)

The docs site builds with:

```bash
npm run docs:build
```

## Example App Reference

If you want a working reference while integrating your own endpoint, inspect the example app in [examples/website](../examples/website). It shows the cookie-based login flow, the protected `/api` route, and the OpenGate config that drives both.

If you want the same story in Express, inspect [examples/express-website](../examples/express-website).
