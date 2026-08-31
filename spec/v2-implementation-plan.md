# OpenGate v2 — Implementation Plan

## Status and Intent

This is the approved implementation plan for the OpenGate redesign. It replaces the old in-app Node middleware product with a standalone, universal HTTP access gateway. The legacy implementation remains in the repository until a separately planned migration/archive step; this plan does not pretend that it is already v2.

The v2 promise is deliberately narrow:

> An administrator registers upstream APIs, roles, and consumers. OpenGate verifies a consumer API key, resolves the consumer's one role for that API, enforces role permissions and limits, then proxies the request.

OpenGate is universal at the upstream boundary: any HTTP API can be protected, regardless of its implementation language.

## Confirmed Product Decisions

| Topic | Decision |
| --- | --- |
| Product shape | Standalone HTTP reverse proxy plus administration service |
| Administration | Web setup page; bootstrap admin followed by password/session login |
| Upstreams | Multiple registered HTTP upstreams |
| Public route shape | `/apis/:apiSlug/*` for the first release |
| Roles | One global role catalog; reusable across APIs |
| Role content | API-scoped method/path permissions plus optional rate and quota limits |
| Consumer assignment | Exactly one role per consumer/API pair |
| Consumer authentication | OpenGate-issued API key in configurable `X-OpenGate-Key` header |
| Key storage | Raw key displayed once; only a keyed hash and public key identifier persist |
| Rate enforcement | Optional token-bucket rate limit and optional calendar-period quota; either may block |
| Usage isolation | Counters are separate per consumer/API assignment |
| Initial public domains | Gateway path only; custom domains deferred |
| Deferred identity modes | Browser/JWT end-user login, SSO, mTLS, and OAuth are extensions, not v2 core |

## Architecture

```text
                    +-------------------------------------+
Administrator ----> | Admin UI + Admin API                 |
                    | APIs, roles, consumers, assignments, |
                    | key issuance, audit review           |
                    +-------------------+-----------------+
                                        |
                                        v
                                  SQLite database

Consumer --> /apis/:slug/* --> OpenGate data path --> upstream HTTP API
              API key            identity -> role -> permission
                                 -> rate limit -> quota -> proxy -> audit
```

### Runtime Choice

v2 will remain TypeScript/Node for its implementation, using Fastify as a standalone server—not as an adapter embedded in a customer's Fastify app. This reuses the team's language experience while allowing any HTTP upstream.

The first deployable runtime is one OpenGate process with a SQLite database. It is suitable for a single node and makes the product operable without containers, Kubernetes, Redis, or PostgreSQL. The process will expose its own HTTP port and can be run directly with `opengate serve` or behind a conventional TLS proxy.

Horizontal scale is an explicit later milestone. It requires PostgreSQL for durable state and Redis (or an equivalent atomic shared store) for rate/quota counters; do not market the SQLite runtime as multi-node safe.

### Packages and Boundaries

Create a new v2 application layout rather than extending the old route-wrapper engine:

```text
src/v2/
  server.ts             # Fastify application composition
  config.ts             # runtime configuration and startup validation
  admin/                # session auth, UI/API routes
  data/                 # database migrations, repositories, transactions
  domain/               # role evaluation, key issuance, limit decisions
  proxy/                # upstream URL construction and streaming proxy
  audit/                # append-only audit writing/querying
  observability/        # health, readiness, metrics, structured logs
  cli.ts                # bootstrap, serve, migrate commands
tests/v2/
```

The old `src/lib`, adapters, examples, and package exports are legacy. Do not mix v2 entities into their config schema. A later cleanup milestone can move those files into `legacy/` or remove them after a published migration notice.

## Data Model

Use database migrations from day one. SQLite must enable foreign keys and WAL mode. All timestamps are UTC ISO-8601 strings or integer UTC milliseconds, consistently selected in implementation.

### Tables

| Table | Essential fields | Constraints and purpose |
| --- | --- | --- |
| `admins` | `id`, `email`, `password_hash`, `enabled`, `created_at` | email unique; password uses Argon2id; at least one enabled bootstrap admin at first start |
| `admin_sessions` | `id`, `admin_id`, `token_hash`, `expires_at`, `created_at`, `revoked_at` | session cookie contains opaque token; token stored hashed; revoke on logout/password reset |
| `apis` | `id`, `name`, `slug`, `upstream_base_url`, `enabled`, `created_at` | `slug` unique; upstream URL must be absolute HTTPS in production; disabled API returns 404/403 without proxying |
| `roles` | `id`, `name`, `description`, `rate_limit_count`, `rate_limit_window_seconds`, `quota_count`, `quota_period`, `enabled` | name unique; each limit pair is either wholly null or positive; quota period is `day` or `month` |
| `role_permissions` | `id`, `role_id`, `api_id` nullable, `method`, `path_pattern` | `api_id = NULL` means all APIs; otherwise the rule only applies to the listed API; permits global roles with API-specific permissions |
| `consumers` | `id`, `name`, `external_reference`, `enabled`, `created_at` | `external_reference` optional and unique when present; represents a person, application, or partner |
| `consumer_api_roles` | `consumer_id`, `api_id`, `role_id`, `assigned_at`, `enabled` | unique `(consumer_id, api_id)`; enforces exactly one active assignment per API |
| `api_keys` | `id`, `consumer_id`, `key_id`, `secret_hash`, `label`, `created_at`, `expires_at`, `revoked_at`, `last_used_at` | `key_id` and `(consumer_id, label)` unique; a key may authenticate only its owning consumer; raw secret never persists |
| `limit_buckets` | `assignment_id`, `kind`, `bucket_key`, `tokens_or_count`, `updated_at`, `expires_at` | atomically updated local counters; `kind` is `rate` or `quota`; quota bucket includes UTC period |
| `audit_events` | `id`, `occurred_at`, `request_id`, `api_id`, `consumer_id` nullable, `role_id` nullable, `key_id` nullable, `method`, `path`, `status_code`, `outcome`, `reason`, `latency_ms`, `upstream_status` nullable | append-only; indexes on time, API, consumer, outcome |

### API Key Format and Verification

Keys use a public identifier plus a secret, for example:

```text
ogk_<key-id>_<high-entropy-secret>
```

Verification parses the identifier, retrieves only that candidate row, and compares an HMAC-SHA-256 of the secret using a server-held pepper with constant-time comparison. This gives fast lookup, avoids stored raw keys, and avoids using an unsalted bare SHA-256 digest. The pepper is a required runtime secret and is never stored in SQLite.

An issued raw key is returned only in the key-creation response and UI confirmation. Audit events and logs must never contain it.

### Permission Matching

Permissions are allow rules. A request is permitted only if at least one role permission matches both:

- its API target (`api_id` equals the selected API, or the permission is global); and
- its normalized HTTP method and normalized path.

Path patterns use a small, documented anchored glob syntax:

```text
/reports/*      matches /reports/today and /reports/2026/08
/reports        matches only /reports
```

No unbounded regular-expression evaluation is allowed in the data path. `*` never crosses the beginning of the path and query strings are excluded from permission matching.

## Request Pipeline

For every request under `/apis/:apiSlug/*`:

1. Generate or accept a validated request ID; log it but never trust it for authorization.
2. Resolve the API by slug. Missing/disabled APIs do not reach an upstream.
3. Extract exactly one configured API-key header. Missing or malformed key returns `401`.
4. Verify the key; reject unknown, expired, revoked, or disabled-consumer keys with a generic `401`.
5. Resolve the consumer's enabled assignment for this API. A missing assignment returns generic `403`.
6. Resolve its enabled role and match its permission rules. A miss returns `403`.
7. Consume active rate limit and quota atomically for this assignment. Exhaustion returns `429`; if both fail, return `429` and record both reasons.
8. Construct the upstream URL by joining the registered base URL and the unmatched suffix safely. Preserve permitted query parameters. Do not accept arbitrary destination URLs from the caller.
9. Proxy the method, body, and safe request headers to the upstream; stream rather than buffering bodies/responses. Strip hop-by-hop headers and the OpenGate API-key header. Apply upstream connect, header, and total-response timeouts plus body-size limits.
10. Return upstream status, headers (after safe filtering), and streamed body. Do not follow arbitrary redirects as the gateway.
11. Write an append-only audit event for every terminal result, including denials and upstream failures.

### Status and Error Contract

| Situation | Response |
| --- | --- |
| Missing/invalid/revoked API key | `401 { "error": "unauthorized" }` |
| API disabled/not found | `404 { "error": "not found" }` |
| Valid consumer without assigned role, disabled role, or denied path/method | `403 { "error": "forbidden" }` |
| Rate or quota exhausted | `429 { "error": "rate limited" }` plus standards-aligned limit/retry headers where known |
| Upstream timeout | `504 { "error": "upstream timeout" }` |
| Upstream unavailable | `502 { "error": "upstream unavailable" }` |

Do not expose consumer names, role names, key state, upstream URLs, or policy internals in denial responses.

## Administration Surface

The setup page uses an internal JSON admin API first; the server-rendered or browser UI is a client of that API. Every mutation creates an audit event with the acting administrator ID.

### Bootstrap and Auth

- `opengate bootstrap-admin --email ...` creates the initial admin interactively without placing a password in shell history.
- Passwords use Argon2id. Login has its own conservative IP/account rate limit.
- Sessions are opaque, hashed in storage, short-lived, `HttpOnly`, `Secure` in production, and `SameSite=Lax`.
- All state-changing browser requests require CSRF protection.
- No default credentials and no unauthenticated setup route after bootstrap completes.

### Required Admin Workflows

| Workflow | Core operations |
| --- | --- |
| APIs | create, list, update, enable/disable, test safe upstream connectivity |
| Roles | create, list, update, enable/disable; manage permission rules and limits |
| Consumers | create, list, update, enable/disable |
| Assignments | assign/change one role to a consumer/API; never silently create a second assignment |
| Keys | issue, list metadata, rotate, revoke; raw value shown once only |
| Audit | filter by time/API/consumer/outcome/request ID; pagination; no raw secrets |

## Operational Configuration

Use environment variables for deployment secrets and server concerns, never the old public JSON config as runtime authority:

```text
OPENGATE_DATABASE_URL=./data/opengate.sqlite
OPENGATE_KEY_PEPPER=...
OPENGATE_SESSION_SECRET=...
OPENGATE_BIND_HOST=127.0.0.1
OPENGATE_PORT=8080
OPENGATE_PUBLIC_BASE_URL=https://gateway.example
OPENGATE_TRUSTED_PROXY_HOPS=0
```

The first startup validates required secrets, database connectivity, safe bind/public URL configuration, and bootstrap state. It must fail closed on invalid configuration.

Expose:

- `/healthz` — process alive;
- `/readyz` — database reachable and migrations current;
- `/metrics` — request, denial, proxy, and limit counters;
- structured JSON logs with request IDs and redaction.

## Security and Reliability Requirements

- Require HTTPS for public traffic in production; document local development exceptions.
- Restrict administrator sessions to the setup/admin origin; never proxy `/admin` paths.
- Validate upstream URLs at creation: allowed protocol, no embedded credentials, no loopback/link-local/private destinations by default in production, DNS rebinding defense, and optional customer-controlled allowlist. This is mandatory SSRF protection.
- Limit header size, body size, concurrent upstream connections, and request duration.
- Strip gateway credentials, forwarded trust headers, hop-by-hop headers, and unsafe upstream response headers before proxying/returning.
- Preserve client IP only through an explicit trusted-proxy configuration; never trust arbitrary `X-Forwarded-For`.
- Use SQLite transactions (`BEGIN IMMEDIATE` where required) so single-node counters cannot over-consume under concurrent requests.
- Make quota consumption durable before proxying. A request that reaches the upstream has consumed access; do not attempt refunds on downstream errors in v2.
- Audit writes may be buffered only if no audit event can be silently discarded; an unhealthy audit store makes readiness fail when audit is configured as required.
- Add dependency scanning, secret scanning, and adversarial proxy tests before public release.

## Delivery Phases

### Phase 0 — Repository Boundary and Foundation

1. Create `src/v2`, `tests/v2`, migration tooling, and a v2 CLI entrypoint without deleting legacy code.
2. Change package metadata/scripts so v2 is explicitly the active executable only once it can start; keep legacy tests separately runnable during transition.
3. Add runtime configuration validation, SQLite initialization, migration runner, health/readiness endpoints, structured logging, and test fixtures.

**Gate:** clean database boots; migration is repeatable; missing secrets/config fail closed; legacy test suite remains unaffected.

### Phase 1 — Administration Domain

1. Implement repository transactions and the data model above.
2. Implement bootstrap admin, login/logout, session handling, CSRF, and admin authorization.
3. Build admin API CRUD for APIs, roles, permissions, consumers, assignments, and key metadata.
4. Implement key issuance/rotation/revocation with the one-time key reveal contract.
5. Build a minimal usable setup UI over that API.

**Gate:** an administrator can create a role, API, consumer, assignment, and API key from a fresh instance; raw keys never appear in database, logs, audit rows, or later list responses.

### Phase 2 — Authorization and Limits

1. Implement safe key parsing/verification and disabled/expired checks.
2. Implement API-specific role resolution with the database unique constraint.
3. Implement anchored permission matching.
4. Implement token-bucket rate limiting and UTC calendar-day/month quota counters using transactional SQLite updates.
5. Return the approved generic status/error contract and rate-limit headers.

**Gate:** table-driven tests prove valid, invalid, revoked, disabled, unassigned, wrong-method, wrong-path, rate-limited, and quota-limited behavior. Concurrent tests prove limits are not exceeded beyond the stated atomicity guarantee.

### Phase 3 — Safe Universal Proxy

1. Implement gateway route matching and safe upstream URL construction.
2. Add streaming request/response forwarding, selected headers, timeout handling, body limits, and abort propagation.
3. Implement SSRF validation and upstream target policy.
4. Add audit events to every decision path and proxy outcome.

**Gate:** integration tests protect both Node and non-Node mock upstreams; deny traffic never reaches upstream; allowed method/path/body/query traffic reaches the expected URL; key/internal headers never leak upstream; upstream failure maps correctly.

### Phase 4 — Operator Experience and Hardening

1. Finish setup UI validation/error states and audit search.
2. Add OpenAPI documentation for admin endpoints, copyable consumer instructions, and a local quick-start example with a simple upstream.
3. Add metrics, operational runbook, database backup/restore guidance, key rotation guidance, and upgrade/migration documentation.
4. Run security review covering SSRF, auth/session fixation, CSRF, proxy smuggling/header handling, quota races, secret leakage, and audit tampering.

**Gate:** a new operator can follow the README from an empty database to a protected upstream without reading source; security review findings are fixed or explicitly accepted before release.

### Phase 5 — Scale-Out (Not Required for Initial Release)

1. Introduce PostgreSQL migration path for durable configuration/audits.
2. Introduce Redis-backed atomic rate/quota counters.
3. Test multi-instance gateway behavior and decide control-plane/config propagation model.
4. Add custom domains only after a secure certificate and routing design exists.

## Migration Strategy

Do not mechanically convert the old `opengate.config.json` model. It represents JWT organizations, embedded route policies, and Node handlers; v2 represents external APIs, consumers, global roles, and proxy routes.

Provide an optional future import assistant that maps only compatible concepts:

- legacy API-key clients -> consumers;
- legacy route policies -> draft API-scoped role permissions;
- legacy rate tiers -> draft role limits.

It must require administrator review before persistence and must never import JWT secrets, raw credentials, or legacy audit data by default.

## Definition of Initial Release

The v2 initial release is complete only when an operator can start one standalone OpenGate instance, sign in as its bootstrap admin, configure at least two upstream APIs and shared roles, register one consumer with a different role on each API, issue a key, and see correct allow/deny/rate/quota behavior while OpenGate proxies requests to both upstream APIs with auditable outcomes.
