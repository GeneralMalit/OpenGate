# OpenGate Installation Guide

This guide covers how to wire OpenGate into your own Fastify endpoint.

The README gives the overview. This page gives the setup.

## What You Need

Before OpenGate can protect an endpoint, you need:
- a Fastify server
- one route you want OpenGate to sit in front of
- a local `opengate.config.json`
- a JWT issuer if you want JWT-based upgraded access
- API keys if you want API-key-based upgraded access
- a writable SQLite file path for audit logs

If you are using the repository locally while developing, keep OpenGate in the same workspace and import it from the local source. If you are wiring this into another service, treat OpenGate like a normal library dependency in that service.

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
| `behavior` | Controls the default deny/block behavior for mismatches or missing identity fields. |

The important defaults in the MVP are:
- `org_id` for the organization claim
- `unique_user_id` for the secondary identity claim
- `UTC` for calendar-day resets
- in-memory rate limiting by default
- SQLite audit logging
- shared-secret JWT verification

## Step 1 - Create The Config

Start with a config file like this:

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
        "keyHash": "sha256-hash-goes-here",
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

If you only need a public route at first, keep the route policy `accessMode` at `public`. If you want logged-in users, switch the route to `authenticated` or `jwt`. If you want server-to-server access, use `api_key`.

## Step 2 - Hash API Keys

Never store raw API keys in config.

Use the library helper:

```ts
import { hashApiKey } from "opengate";

const keyHash = hashApiKey("your-raw-api-key");
```

Store `keyHash` in `apiKeys.clients[].keyHash`.

At runtime, OpenGate hashes the presented header value and compares hashes. The raw key itself is never used as the stored secret.

## Step 3 - Register A Route Through OpenGate

OpenGate is meant to sit in front of an existing handler:

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

## Step 4 - Connect JWT Issuance

OpenGate verifies JWTs. It does not mint them for your application.

Your issuer must sign tokens with the same shared secret OpenGate knows about. Each token should include:
- `iss`
- `aud`
- `exp`
- `sub`
- `unique_user_id`
- the organization claim, usually `org_id`

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

Audit logging writes to SQLite when enabled. Make sure the configured path is writable by the host process.

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

## Step 7 - Verify The Integration

Once the endpoint is wired, test the basic flows in this order:

1. Anonymous request to a public route returns `200`.
2. Login or mint a JWT and confirm upgraded access returns the paid-tier response shape.
3. Send a bad JWT and confirm the request is rejected.
4. Send a valid API key to an API-key route and confirm it passes.
5. Send enough requests to trigger the configured tier limit and confirm `429`.
6. Check the SQLite audit file and confirm rows are written for both allowed and blocked requests.

## Current MVP Limitations

The MVP deliberately keeps the surface area small:
- Fastify-first only
- in-memory rate limiting by default
- SQLite audit logging only
- shared-secret JWT verification

## Production Note

The MVP uses shared-secret JWT verification because it is simple and easy to validate. That is appropriate for the first implementation and tightly controlled environments.

For production, switch to asymmetric JWT verification so OpenGate validates with a public key instead of sharing the signing secret.

## Example App Reference

If you want a working reference while integrating your own endpoint, inspect the example app in [examples/website](../examples/website). It shows the cookie-based login flow, the protected `/api` route, and the OpenGate config that drives both.
