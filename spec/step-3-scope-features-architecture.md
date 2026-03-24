# Step 3 - Scope, Features, and Architecture

## Context
OpenGate MVP is a library-first gateway for websites with existing HTTP endpoints. Developers install and configure it locally so free-tier and upgraded-tier handling become automatic. The example app exists to demonstrate the full story end to end: a hidden endpoint protected by OpenGate, a fake login that produces upgraded JWT traffic, simple rate limiting, and audit logging.

## MVP Scope

### In Scope
- OpenGate as a configurable library embedded into an existing backend or website server.
- A single local config file as the source of truth for gateway behavior.
- Free-tier and upgraded-tier request handling.
- JWT validation for upgraded access using shared-secret verification.
- Multiple JWT issuer and audience configurations.
- Required upgraded JWT claims: `iss`, `aud`, `exp`, `sub`, and `unique_user_id`.
- Optional `scope` support in the model, but not required for the example flow.
- Default JWT organization mapping through `org_id`, while keeping the mapping configurable.
- API-key authentication as a separate upgraded path.
- SHA-256 hashed API-key verification.
- Default deny behavior when JWT and API key are both present but do not match the configured expectation.
- Default reject behavior when required upgraded identity context is missing.
- Configurable rate-limit storage with in-memory as the default MVP store.
- SQLite audit logging only.
- A separate example website folder that demonstrates the full OpenGate flow on `/api`.
- Simple rate-limit responses that say `rate limited`, optionally including the last successful access time when locally available.
- Reason-specific HTTP status behavior with `401`, `403`, and `429` where appropriate, and `403` as the fallback deny status.
- Calendar-day rate-limit resets with a configurable timezone and `UTC` as the default.
- JSON as the MVP config-file format.

### Example App MVP Behavior
- Public visitors can call `GET /api` through OpenGate as free-tier traffic.
- Logged-in demo users can call `GET /api` through OpenGate as upgraded JWT traffic.
- The demo login flow uses one demo organization with multiple demo users.
- The demo login flow uses a visible username/password login form and stores the JWT in an `HttpOnly` cookie.
- The example app includes logout to return the user to free-tier behavior.
- The underlying handler is not exposed directly; OpenGate sits in front of it and the browser experience remains a normal `/api` call.
- The endpoint returns current time and a simple status message.
- Upgraded responses visibly indicate paid-tier access.
- The upgraded response keeps the same shape as the free-tier response with one extra paid-tier field.
- Example default limits are `10/day` for free tier and `1000/day` for upgraded tier.
- Example daily limits reset on calendar-day boundaries.

## Exclusions
- Full standalone reverse-proxy product mode in the MVP.
- Production asymmetric JWT verification in the MVP.
- Distributed/shared production rate-limit backends such as Redis in the example implementation.
- Complex multi-route authorization demos.
- Admin UI, dashboard, or tenant management UI.
- Browser cross-site support work.
- Rich partner onboarding flows.

## Deferrals
- Additional tier levels beyond `free` and `upgraded`.
- Route-specific quota overrides.
- JWKS or asymmetric key verification.
- Advanced audit retention policies.
- More realistic external identity-provider integration.
- Multiple example apps.

## Non-Goals
- Becoming a full API management platform.
- Hiding all gateway concepts from developers; the library should still be explicit and configurable.
- Solving horizontal scaling in the first implementation.

## Feature Mapping

### Feature: Library Integration Layer
Purpose: let developers install OpenGate into an existing backend and place a gate in front of selected handlers without rewriting the handler logic.
User story served: protects specific endpoints without changing the upstream service shape.

### Feature: Config-Driven Policy Engine
Purpose: load local policy, auth, rate-limit, and audit settings from one config file.
User story served: makes the gateway configurable and reusable across apps.

### Feature: JWT Upgraded Access
Purpose: allow logged-in users to access upgraded-tier behavior using trusted JWTs plus required `unique_user_id`.
User story served: differentiates public and logged-in users without exposing raw API credentials.

### Feature: API-Key Upgraded Access
Purpose: support server-to-server or partner access as a separate upgraded path.
User story served: lets private partners or service clients use stronger, explicit credentials.

### Feature: Tiered Rate Limiting
Purpose: apply different limits to free-tier and upgraded-tier traffic automatically.
User story served: gives public and logged-in users different levels of access.

### Feature: Audit Logging
Purpose: persist request outcomes, route matches, resolved identity context, selected JWT claims, and rate-limit behavior to SQLite.
User story served: provides a clear audit trail of what happened to each request.

### Feature: Demo Website
Purpose: show the whole product story with one small, understandable route.
User story served: helps developers see how OpenGate is integrated and what protections it adds.

## Architecture

### Primary Components
- `opengate-core` library
  - Loads config
  - Evaluates request identity
  - Resolves route policy
  - Selects tier
  - Applies rate limiting
  - Writes audit events
  - Invokes the protected handler only when allowed
  - Exposes a higher-level route registration helper that takes a handler plus one route-config object
  - Supports the protected-handler registration pattern used by the example app

- Auth engine
  - Verifies shared-secret JWTs
  - Validates issuer, audience, expiry, subject, organization claim, and required `unique_user_id`
  - Verifies API keys using stored SHA-256 hashes
  - Applies mismatch rules when JWT and API key are both present
  - Blocks requests that resolve to disabled organizations by default
  - Treats JWT as the default primary identity when both valid JWT and API key are present on an `authenticated` route

- Policy engine
  - Matches route path prefixes
  - Decides `public`, `authenticated`, `jwt`, or `api_key` access
  - Enforces optional scopes when configured

- Rate-limit engine
  - Uses a store abstraction
  - Defaults to in-memory store for MVP/demo
  - Keys free-tier traffic by IP
  - Keys upgraded JWT traffic by resolved identity
  - Keys upgraded API-key traffic by API key

- Audit engine
  - Writes append-only SQLite rows
  - Stores matched route-policy id, identity type, organization context, selected JWT claims, and request outcome

- Example website app
  - Separate folder from OpenGate library code
  - Fake login flow to mint demo JWTs
  - Hidden internal handler for `/api`
  - OpenGate-wrapped public `/api` route exposed to the browser

### Data Flow
1. Browser calls `/api` on the example website.
2. The server route enters OpenGate library middleware first.
3. OpenGate reads config and matches the route policy.
4. OpenGate resolves identity:
   - no credentials -> free-tier anonymous request
   - valid JWT with required claims -> upgraded JWT request
   - valid API key -> upgraded API-key request
5. OpenGate validates organization status, mismatch rules, and missing-context rules.
6. OpenGate selects the rate-limit tier and checks the configured store.
7. If blocked, OpenGate returns a simple rejection response with the best-fit status code and logs the event.
8. If allowed, OpenGate calls the hidden handler.
9. OpenGate stores the audit event in SQLite and returns the upstream response.

### Boundaries
- OpenGate library owns auth, tiering, rate limiting, and audit concerns.
- The host application owns business logic and the hidden endpoint handler.
- The example website owns demo login, demo tokens, and user-facing pages.
- The example website owns caller-side last-successful-access display behavior in browser storage.
- Config file owns deployment-specific behavior.

## Recommended MVP Technical Choices
- Product shape: embedded library
- Config source: local JSON config file
- JWT verification: shared secret
- API-key hashing: SHA-256
- Rate-limit store: configurable abstraction with in-memory default
- Audit store: SQLite only
- Example auth: fake local login flow
- Example auth transport: cookie-based JWT
- Default integration style: higher-level route registration helper
- Default audit JWT claim snapshot: `iss`, `aud`, `sub`, `org_id`, `unique_user_id`

## Deployment and Workflow Implications
- No separate gateway process is required for the MVP library path.
- Developers integrate OpenGate into their existing backend route stack.
- The example app should make the integration points obvious in code, since demo clarity is a top priority.
- Config changes should not require schema redesign in the MVP.
- Future production evolution should leave room for asymmetric JWT verification and stronger external rate-limit stores.

## Risks and Assumptions
- In-memory rate limiting is suitable for demo and single-node development, but not the final production scaling story.
- Shared-secret JWT verification keeps the MVP small, but production direction should move to asymmetric verification.
- The single `/api` route makes the example easy to understand, but it limits how much route-based authorization is demonstrated.
- Organization resolution from JWT claims needs to stay explicit in config so issuer logic does not become ambiguous.
- The `org_id` default should stay easy to override so developer setup does not become rigid.
- Generic blocked responses are safer for the demo, but they reduce diagnostic detail unless developers inspect the audit log.
- Independent per-key scopes are simpler for the MVP than mixing organization defaults with override layers.
