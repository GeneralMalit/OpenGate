# OpenGate

> Status: the standalone v2 gateway is implemented in `src/v2`. The earlier Node-library code remains in this repository as legacy code during the migration.

The build-ready architecture and phased delivery plan are in [spec/v2-implementation-plan.md](spec/v2-implementation-plan.md).

## Run OpenGate v2

The first v2 runtime is a standalone, single-node service backed by SQLite. It does not require Docker or Kubernetes.

```powershell
npm install
npm run build

$env:OPENGATE_DATABASE_URL = "./data/opengate.sqlite"
$env:OPENGATE_KEY_PEPPER = "replace-with-a-random-secret-at-least-32-characters"
$env:OPENGATE_SESSION_SECRET = "replace-with-a-different-random-secret-at-least-32-characters"
$env:OPENGATE_PUBLIC_BASE_URL = "http://127.0.0.1:8080"

node dist/src/v2/main.js migrate
node dist/src/v2/main.js bootstrap-admin --email admin@example.com
node dist/src/v2/main.js serve
```

The bootstrap command securely prompts for a password; it intentionally refuses passwords passed on the command line. Open `http://127.0.0.1:8080/admin` to configure APIs, roles, consumers, assignments, and keys.

For development, use `npm run v2:dev` after setting the same environment variables. Production deployments must use an HTTPS public URL and HTTPS upstream APIs. The initial SQLite runtime is for one gateway process; do not run multiple instances against it for shared quota enforcement.

See [v2 operations](docs/v2/OPERATIONS.md) for backups, key rotation, health checks, and production restrictions.

OpenGate will be a universal access gateway for existing HTTP APIs.

You register an upstream API, define shared roles, register API consumers, and assign each consumer one role for each API. Consumers call OpenGate with an API key; OpenGate decides whether their role can use the requested path and method, enforces its limits, and forwards allowed traffic to the upstream API.

```text
API consumer
  -> OpenGate public gateway
      -> verify API key
      -> resolve consumer's role for this API
      -> check method/path permission
      -> check rate limit and usage quota
      -> proxy allowed request to the upstream API
```

OpenGate is deliberately independent of the upstream language or framework. The upstream may be a Node, Python, Go, Java, PHP, or third-party HTTP API.

## What OpenGate Is For

Use OpenGate when you need a straightforward, centrally managed way to control who may call existing APIs and how much access they have.

It is not intended to be a feature-for-feature replacement for an enterprise API gateway such as Kong. OpenGate focuses on the access-management problem:

- register multiple upstream APIs in one place;
- create reusable roles;
- grant a registered consumer one role for a particular API;
- issue a consumer API key;
- allow or deny requests by method and path;
- enforce both burst rate limits and longer-period usage quotas;
- audit gateway decisions.

## Core Model

### APIs

An API is an upstream HTTP service OpenGate proxies to. An administrator registers it with a name, URL, and public gateway slug.

```text
Name: Weather API
Upstream URL: https://weather.internal.example/v1
Gateway URL: https://gateway.example/apis/weather/*
```

OpenGate forwards the remaining path and request details to the configured upstream only after access checks pass.

The v2 default is OpenGate-hosted gateway paths such as `/apis/weather/*`. Custom domains are intentionally deferred until after the core gateway is stable.

### Roles

Roles are shared across OpenGate. They define the access a consumer receives, regardless of which API they are assigned to.

A role contains:

- permitted HTTP method/path rules, such as `GET /reports/*`;
- an optional burst rate limit, such as `10 requests/minute`;
- an optional usage quota, such as `1,000 requests/day`.

Both limits can be active. The first exhausted limit blocks the request.

```text
Role: analyst

Permissions
  - GET /reports/*
  - GET /exports/*

Limits
  - 30 requests/minute
  - 5,000 requests/month
```

Roles are not sent by a consumer in a request. A consumer could forge a `role` header. OpenGate derives the role from its own assignment records after verifying the consumer's API key.

### Consumers and API Keys

A consumer is a person, application, or partner service that has been registered by an administrator.

For each API, a consumer has exactly one role. This prevents ambiguous permissions and competing limits.

```text
Ava
  - Weather API: analyst
  - Billing API: viewer
```

OpenGate issues a high-entropy API key for the consumer. The raw key is shown once at creation time and is never stored. OpenGate stores only a secure hash of it.

The consumer supplies the key with each request:

```http
X-OpenGate-Key: og_live_...
```

The header name will be configurable, with `X-OpenGate-Key` as the default.

### Quota Scope

Usage is counted separately for every consumer/API assignment.

```text
Ava + Weather API: 5,000 requests/month
Ava + Billing API: 5,000 separate requests/month
```

Traffic to one API never consumes the consumer's quota for another API.

## Request Decision Flow

For a request such as `GET /apis/weather/reports/today`:

1. OpenGate resolves `weather` to the registered API.
2. It verifies the supplied API key.
3. It finds the consumer's single role assignment for the Weather API.
4. It checks that the role allows `GET /reports/today`.
5. It checks the role's active rate limit and usage quota for this consumer/API pair.
6. If either limit is exhausted, OpenGate rejects the request with `429 Too Many Requests`.
7. If the method/path is not permitted, OpenGate rejects it with `403 Forbidden`.
8. If the key is missing, invalid, revoked, or lacks an assignment, OpenGate rejects it with `401 Unauthorized` or `403 Forbidden`, as appropriate.
9. Otherwise, OpenGate proxies the request to the registered upstream and records the outcome.

## Administrator Setup Flow

OpenGate provides a setup page for administration. The first release uses a bootstrap administrator account and normal username/password login with secure sessions. SSO is a later extension.

An administrator operates OpenGate in this order:

1. Create a role and define its permitted paths/methods and limits.
2. Register an upstream API and choose its gateway slug.
3. Register a consumer.
4. Assign that consumer exactly one shared role for the API.
5. Issue the consumer's API key and deliver it securely.
6. Give the consumer the gateway URL and required key header.
7. Review request/audit records and rotate or revoke keys when needed.

## Initial Product Decisions

These are confirmed design decisions for the redesign:

| Area | Decision |
| --- | --- |
| Product shape | Standalone universal HTTP gateway; not an in-app Node library |
| Upstreams | Multiple registered HTTP APIs, independent of implementation language |
| Public routing | Gateway-managed paths: `/apis/:apiSlug/*` |
| Custom domains | Deferred from the initial release |
| Admin access | Bootstrap admin, username/password login, secure sessions |
| Roles | One shared role catalog across OpenGate |
| Assignment | Exactly one role per consumer, per API |
| Identity | OpenGate-issued API keys sent in a configurable request header |
| Key storage | Raw key shown once; only a secure hash is stored |
| Authorization | Role rules define permitted HTTP methods and path patterns |
| Limits | Optional rate limit and optional usage quota; either may block first |
| Usage scope | Separate counter per consumer/API assignment |
| Proxy behavior | Only allowed requests are forwarded to the configured upstream |

## What Is Deliberately Deferred

To keep the first universal version understandable and operable, the following are not part of its initial core:

- custom API domains;
- browser end-user login/JWT flows;
- billing, subscription, or product-plan management;
- multiple concurrent roles for one consumer/API assignment;
- SSO for setup administrators;
- advanced enterprise traffic management, service discovery, and multi-region control planes.

## Current Repository

The existing codebase is the previous implementation: a Node/TypeScript library with Fastify and Express adapters, JWT/API-key handling, rate limits, audits, a CLI, and example applications. It is useful reference material, but it is not the v2 architecture described above.

The next implementation phase should replace the Node route-wrapper model with a standalone reverse-proxy gateway and administration service built around the core model in this README.
