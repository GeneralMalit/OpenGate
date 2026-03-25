# Step 7 - Product Roadmap

## Purpose

This roadmap describes how OpenGate gets from a solid MVP to a 10/10 product. The MVP proves the core idea: embed a gate into an existing endpoint, control access with config, and keep rate limiting, identity, and audit behavior in one place. The roadmap below focuses on the upgrades that materially improve trust, adoption, scale, and long-term maintainability.

The order matters. Security and correctness come first, developer experience comes next, then scale, then ecosystem breadth.

## What A 10/10 Version Needs

OpenGate is a 10/10 product when all of the following are true:

- It is safe by default, with strong key handling, clear identity rules, and predictable failure modes.
- It is easy to install in a real backend without reading the source first.
- It works with more than one web framework and does not trap the user in one integration style.
- It scales from a single-node demo to a production deployment without rewriting the policy model.
- It is observable, auditable, and easy to operate under incident pressure.
- It is clear to adopt, document, and support for teams that are not already familiar with the codebase.

## Phase 0 - Stabilize The Core Product

Before OpenGate grows into a broader platform, the MVP needs to be dependable enough that the team can trust its shape. Stability here does not mean “feature complete”; it means the product stops changing in ways that make adoption risky.

Stabilize by doing the following:
- Lock the public library API and avoid breaking it without a clear version bump.
- Keep the route registration helper, config schema, and request context stable.
- Keep the example website working as a reference implementation, not a moving target.
- Make the core test suite pass reliably on clean checkout and in CI.
- Keep the release pipeline working so versioning, changelog generation, and GitHub release automation are dependable.
- Make the installation guide and README match the real behavior, not the planned behavior.
- Close the major correctness gaps before adding new product surface area.

What “stable” means in practice:
- A developer can install the library and protect a route without reading the source.
- The same config produces the same request behavior across test runs.
- The core auth, tiering, rate-limit, and audit flows are covered by tests.
- Release automation works without manual intervention.
- The docs describe the shipped behavior accurately.

Exit criteria:
- Core tests are reliable and the coverage target is met for `src/`.
- The example app is a trustworthy reference, not a source of hidden behavior.
- The release pipeline can produce and tag a version successfully.
- The public API is frozen enough to support real adoption.

## Phase 1 - Make The Core Security Model Production-Grade

The MVP is intentionally simple. The first upgrade phase should make the security model stronger without changing the product shape.

Upgrade:
- Replace shared-secret JWT verification with asymmetric JWT verification for production deployments.
- Add JWKS support so OpenGate can consume rotating public keys from external identity providers.
- Add key rotation rules for JWT issuers and API-key clients.
- Add explicit token audience validation examples for real deployments.
- Add credential revocation semantics for API keys and JWT issuer disablement.
- Add stronger audit redaction rules so only approved claim snapshots are stored.

Do:
- Make the JWT issuer model support both local demo issuers and remote production issuers.
- Add configuration examples for common identity providers.
- Define a migration path from shared-secret MVP configs to asymmetric production configs.
- Add tests for key rotation, revoked keys, disabled issuers, and mismatched audience handling.

Why this matters:
- Shared secrets are acceptable for MVP, but they do not scale well across teams and environments.
- Asymmetric verification is safer for real-world deployments and reduces the blast radius of secret exposure.

Exit criteria:
- JWT verification works with both shared-secret demo mode and asymmetric production mode.
- Key rotation can happen without breaking valid requests.
- Audit data remains minimal and privacy-safe.

## Phase 2 - Make OpenGate Easy To Install

A great product is not only correct, it is easy to adopt. The next upgrade phase should focus on reducing setup friction.

Upgrade:
- Add a CLI initializer, such as `opengate init`, that generates a config file and a starter route.
- Add a config validator that explains errors in plain language.
- Add generated examples for the most common setups: public route, JWT route, API-key route, and mixed-auth route.
- Add a migration helper for users moving from older config shapes.
- Add first-class support for local development workflows, including demo credentials and sample audit files.

Do:
- Make the default config output minimal but valid.
- Keep the config file human-readable and stable over time.
- Add docs that show the shortest path from “empty Fastify server” to “protected endpoint”.
- Add copy-paste examples for teams that want to get running in minutes, not hours.

Why this matters:
- Installation friction is one of the main reasons good libraries fail to spread.
- People should feel that OpenGate is easy to wire in before they understand every internal detail.

Exit criteria:
- A new developer can install OpenGate and protect a route without reading the spec.
- The config file can be created and validated in one pass.
- Common integration mistakes produce helpful errors.

## Phase 3 - Expand Framework Coverage

The MVP is Fastify-first, which is the right starting point. The next stage is making the core policy model reusable across more frameworks.

Upgrade:
- Add adapters for additional Node frameworks, starting with Express or Hono.
- Separate the pure policy engine from the transport adapter so the core logic is framework-agnostic.
- Standardize request identity, policy resolution, and audit event creation behind a common interface.
- Keep the route registration helper pattern consistent across adapters.

Do:
- Define a shared internal request contract that every adapter can produce.
- Keep framework-specific code thin and isolated.
- Add adapter-specific examples rather than forking the product design.
- Preserve one config model across all supported frameworks.

Why this matters:
- The more the core logic depends on one framework, the harder the product is to grow.
- A reusable engine makes OpenGate feel like a product, not a one-off integration.

Exit criteria:
- The same config file works across multiple adapters.
- Policy and rate-limit logic do not need to be rewritten for each framework.
- The public API stays consistent even when the transport layer changes.

## Phase 4 - Make Rate Limiting And Audit Scale Out

The MVP uses simple local storage because that is the right tradeoff for a first release. A 10/10 product needs distributed storage options.

Upgrade:
- Add Redis as a rate-limit store for horizontally scaled deployments.
- Add Postgres or another durable store for audit events where SQLite is not enough.
- Add retention policies so audit data can be archived or pruned safely.
- Add asynchronous audit writes for high-throughput workloads.
- Add backpressure and failure handling so observability does not become a bottleneck.

Do:
- Keep the in-memory store for local dev and simple deployments.
- Make the storage backend a clear config choice, not a hidden behavior.
- Add operational guidance for single-node versus multi-node deployments.
- Add tests that prove rate-limit behavior is stable across clock boundaries and store backends.

Why this matters:
- Local-only storage is fine for MVP, but it becomes a wall as soon as traffic or compliance requirements grow.
- Teams need a clear scale-up path that does not force them into a re-architecture.

Exit criteria:
- OpenGate can run in a single-node mode and a distributed mode with the same policy config.
- Audit logs are durable enough for real operational use.
- Rate limiting stays consistent across nodes.

## Phase 5 - Make Operations Visible

A good security product should be easy to observe. If a team cannot see what OpenGate is doing, they will not trust it in production.

Upgrade:
- Add metrics for allowed requests, blocked requests, rate-limit hits, auth failures, and audit write failures.
- Add tracing or request correlation identifiers for end-to-end debugging.
- Add health and readiness endpoints for deployed environments.
- Add structured logs with a stable event shape.
- Add admin-visible reporting for route usage and policy behavior.

Do:
- Keep metrics low-cardinality and useful.
- Make it easy to tell whether a failure came from auth, policy, storage, or user config.
- Provide operational examples for dashboards and alerts.
- Preserve privacy by keeping logs and metrics focused on metadata, not raw secrets.

Why this matters:
- Trust grows when operators can explain exactly why a request was allowed or denied.
- Incident response gets much easier when the product emits clear signals.

Exit criteria:
- A team can answer “what is happening?” from metrics and logs alone.
- Common failure modes are easy to distinguish.
- OpenGate is safe to run with real alerts and dashboards.

## Phase 6 - Build The Product Layer Around The Engine

Once the core engine is strong, the product can grow into a more complete platform.

Upgrade:
- Add a lightweight admin interface or control plane for policies and keys.
- Add self-serve API-key issuance and revocation workflows.
- Add organization-level management for tenants, users, and access policies.
- Add import/export for policy configurations.
- Add a local policy preview or simulation tool so teams can test a config before rollout.

Do:
- Keep the engine and the product UI separate.
- Let the UI talk to the same config and policy model the runtime uses.
- Make policy changes reviewable, auditable, and reversible.
- Keep the first-party demo app and the real product control plane clearly separated.

Why this matters:
- The product becomes more valuable when teams can manage it without editing JSON by hand every time.
- Self-serve controls and policy simulation reduce support burden and operational risk.

Exit criteria:
- Policies and keys can be managed without editing raw config files for every change.
- The system supports multi-user and multi-organization workflows.
- The admin layer does not contaminate the runtime core.

## Phase 7 - Improve Distribution And Ecosystem Fit

The final step toward a 10/10 product is making OpenGate fit naturally into the developer ecosystem around it.

Upgrade:
- Publish clear adapter packages, starter templates, and example apps.
- Add a proper upgrade and migration guide between versions.
- Add more sample endpoints and vertical-specific examples.
- Add integration notes for common authentication providers and API client setups.
- Add release automation and versioning discipline for stable upgrades.

Do:
- Keep the main README high-level and the deeper setup docs separate.
- Give teams a predictable upgrade path with minimal breaking changes.
- Make example apps feel like real starting points, not toy demos.
- Keep the documentation honest about what is supported now versus later.

Why this matters:
- Great products spread when teams can adopt them confidently and upgrade them without drama.
- Clear ecosystem support reduces the cost of the first successful deployment.

Exit criteria:
- The project feels easy to adopt, easy to extend, and easy to trust.
- The docs, releases, examples, and code all tell the same story.

## What To Delay Until The Core Is Strong

These are useful ideas, but they should wait until the core product is stable:

- A full enterprise policy language.
- Multi-cloud deployment automation.
- Large-scale analytics dashboards.
- Deep workflow approval systems.
- Non-Node language ports before the core model is proven.
- Complex multi-step authorization flows that make the first install harder.

## Recommended Order

If you are deciding what to do next, follow this order:

1. Security and trust.
2. Installability and developer experience.
3. Framework expansion.
4. Distributed storage and scale.
5. Observability and operations.
6. Product layer and admin workflows.
7. Ecosystem and distribution.

That order keeps the product honest: make it safe first, then easy, then scalable, then elegant.
