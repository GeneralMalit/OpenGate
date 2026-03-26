# Step 5 - Execution Plan

## Planning Status
The spec is now clear enough to plan execution. This plan maps implementation work back to the formal spec in Step 4 and keeps the MVP focused on demonstration value.

## Phase 1 - Core Library Foundation
- [ ] Create the core library package shape and public entry point for embedded use.
  - Maps to spec: `1`, `2`, `3`, `61`, `63`, `64`, `67`
- [ ] Define the local JSON config structure and loader for gateway behavior.
  - Maps to spec: `3`, `9`, `13`, `14`, `20`, `23`, `39`, `67`
- [ ] Implement the default higher-level route registration helper using `handler + route-config object`.
  - Maps to spec: `61`, `62`, `63`, `65`
- [ ] Implement the protected-handler registration pattern used by the example app.
  - Maps to spec: `53`, `60`, `65`

## Phase 2 - Authentication and Identity
- [ ] Implement shared-secret JWT verification with support for multiple issuers and audiences.
  - Maps to spec: `6`, `9`, `10`, `11`, `12`, `13`, `14`
- [ ] Implement default JWT organization mapping via `org_id`, while keeping claim mapping configurable.
  - Maps to spec: `13`, `14`, `33`
- [ ] Implement required `unique_user_id` handling from JWT claims with global uniqueness semantics.
  - Maps to spec: `15`, `16`, `17`, `18`, `19`
- [ ] Implement organization status checks and block disabled organizations by default.
  - Maps to spec: `33`
- [ ] Implement SHA-256 API-key verification and organization-linked API-key records.
  - Maps to spec: `7`, `18`, `20`, `21`, `22`
- [ ] Implement default JWT/API-key mismatch behavior and matching rules.
  - Maps to spec: `28`, `30`, `31`, `32`, `66`

## Phase 3 - Policy, Tiering, and Audit
Current repository status:
- Implemented in the current codebase: shared transport-neutral request processing now powers both Fastify and Express adapters, with the current Fastify API preserved and an Express demo added for parity.

- [x] Implement route policy matching with longest-prefix behavior and access modes.
  - Maps to spec: `21`, `23`, `24`, `25`, `26`, `27`, `28`, `34`
- [x] Implement optional scope enforcement.
  - Maps to spec: `30`, `34`
- [x] Implement free-tier and upgraded-tier rate limiting with configurable storage and in-memory default.
  - Maps to spec: `31`, `32`, `35`, `36`, `37`, `38`, `39`, `40`, `41`, `68`
- [x] Implement calendar-day reset logic with configurable timezone and default `UTC`.
  - Maps to spec: `41`, `68`
- [x] Implement default rejection status/message behavior.
  - Maps to spec: `37`, `42`, `43`, `44`, `45`
- [x] Implement SQLite audit logging with route-policy id, identity context, organization context, and selected JWT claims.
  - Maps to spec: `44`, `45`, `46`, `47`, `48`, `49`, `50`, `51`, `52`, `53`, `54`, `55`, `56`, `57`

## Phase 4 - Example Website
- [ ] Create a separate example website folder that consumes the OpenGate library.
  - Maps to spec: `54`, `63`, `69`
- [ ] Build the visible username/password demo login flow for one organization and multiple users.
  - Maps to spec: `55`, `60`, `61`, `64`, `65`, `66`, `67`, `70`, `71`, `72`, `73`, `74`
- [ ] Implement JWT cookie issuance using an `HttpOnly` cookie.
  - Maps to spec: `66`, `72`
- [ ] Expose a single `GET /api` route that is protected by OpenGate and backed by a hidden handler.
  - Maps to spec: `51`, `53`, `56`, `57`, `62`, `68`, `69`, `75`, `76`
- [ ] Return the same JSON shape for free-tier and upgraded-tier responses, with one extra paid-tier field for upgraded users.
  - Maps to spec: `70`, `71`, `76`, `77`, `78`
- [ ] Implement optional browser-local "last successful access" display in the example app only.
  - Maps to spec: `73`, `80`
- [ ] Add logout to return the user to free-tier behavior.
  - Maps to spec: `73`

## Phase 5 - Verification and Documentation
- [ ] Add tests for free-tier access, upgraded JWT access, disabled-organization blocking, JWT/API-key mismatch denial, API-key upgraded access, and rate limiting.
  - Maps to spec: `4` through `58` as relevant
- [ ] Add tests for calendar-day resets and timezone handling.
  - Maps to spec: `41`, `68`
- [ ] Add tests for audit-record shape and JWT claim snapshot storage.
  - Maps to spec: `47` through `57`
- [ ] Update README usage docs to reflect library-first integration, JSON config, shared-secret MVP JWT, and the example app.
  - Maps to spec: `1`, `3`, `10`, `67`, `69` through `79`

## Suggested Implementation Order
1. Core library foundation
2. JWT and API-key identity resolution
3. Route policy and tier selection
4. Rate limiting
5. Audit logging
6. Example website integration
7. Tests and docs

## Risk Notes
- Calendar-day resets can become subtly wrong if timezone handling is inconsistent between config, runtime, and tests.
- Cookie-based demo auth is better for realism, but browser cookie behavior can obscure what is happening unless the example docs are very clear.
- Debug-oriented JWT claim snapshots are useful, but they increase the chance of logging more identity data than necessary if not constrained.

## Three Things We Are Not Considering
1. Cross-process and horizontally scaled rate limiting.
   - Why it matters: the in-memory default is fine for the demo, but it is not the production story.
2. Sensitive-data minimization in audit logs.
   - Why it matters: debugging value can conflict with least-privilege logging, especially once real organizations use the library.
3. How developers migrate from shared-secret MVP JWT to asymmetric production JWT.
   - Why it matters: the code structure should make that upgrade path straightforward instead of deeply coupling the MVP to one verification mode.

## Exit Criteria For Step 5
- The user agrees the phases and ordering make sense.
- The user agrees the "three things" section is capturing the right hidden risks.
- The plan is specific enough that Step 6 can request tests first and then execute in phases.

## Roadmap Phase 1 Follow-On
With the MVP now implemented, the next accepted execution track is the roadmap Phase 1 security hardening pass:

- add dual-mode JWT support with shared-secret demo issuers and production JWKS issuers
- add issuer disablement and JWKS rotation handling
- add versioned API-key rotation and revocation semantics
- harden audit redaction so only approved JWT claims can be stored
- document the migration path from legacy shared-secret and single-hash configs

## Roadmap Phase 4 Follow-On
The scale-out path is now also implemented in the current codebase:

- add Redis as a rate-limit store for distributed deployments
- add buffered asynchronous audit writes
- add PostgreSQL as a durable audit sink
- keep the in-memory and SQLite defaults for local and single-node usage
- document the operational split between local defaults and multi-node backends

## Roadmap Phase 5 Follow-On
The operational visibility layer is also implemented in the current codebase:

- add request correlation IDs to the request context and audit rows
- add structured logger adapters for request completion events
- expose health, readiness, metrics, and status routes through the same library helpers
- keep the operational routes lightweight so they fit the library-first integration style

## Roadmap Phase 7 Follow-On
The distribution layer is also implemented in the current codebase:

- publish explicit Fastify and Express adapter packages alongside the root compatibility package
- add starter templates for the website, API, and partner/server-to-server paths
- keep the docs repo-owned and versioned alongside the packages
- replace the old single-package release flow with Changesets-based version PRs

