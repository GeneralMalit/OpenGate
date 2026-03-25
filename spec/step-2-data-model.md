# Step 2 - Data Model

## Purpose
This data model translates the Step 1 behavior into the smallest set of entities needed to protect upstream API endpoints, apply access rules, enforce request limits, and record what happened to each request.

This draft is intentionally split into:
- MVP model: the smallest model that can satisfy the current problem frame.
- Later model: extensions that are likely useful, but should stay out of the first version unless Step 3 explicitly pulls them in.

## Domain Glossary
- Gateway: the OpenGate process sitting in front of an upstream API.
- Upstream API: the existing service being protected.
- Route policy: the rule set that applies to a path prefix.
- API client: a partner or consumer identified by an API key.
- JWT identity: a logged-in caller whose identity is derived from a JWT.
- Secondary identifier: an additional developer-defined identifier sent with authenticated traffic when needed, such as a stable user id.
- Rate limit tier: the quota window assigned to a request class.
- Audit event: the immutable record of how a request was handled.
- IP policy: an optional rule restricting which source IPs are allowed.

## MVP Model

### 1. GatewayConfig
Represents one running OpenGate instance and its shared runtime settings.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| id | string | yes | n/a | Logical identifier for the gateway config. |
| host | string | yes | `"0.0.0.0"` | Bind address for the gateway server. |
| port | number | yes | `8080` | Listener port. |
| upstream_url | string | yes | n/a | Base URL of the protected upstream service. |
| api_key_header | string | yes | `"x-api-key"` | Header name used to read API keys. |
| audit_enabled | boolean | yes | `true` | Whether audit logging is active. |
| audit_store_path | string | yes | n/a | SQLite file path or equivalent audit sink path. |

Relationships:
- `GatewayConfig` has many `RoutePolicy`
- `GatewayConfig` has many `Organization`
- `GatewayConfig` has many `ApiClient`
- `GatewayConfig` has many `RateLimitTier`
- `GatewayConfig` has many `JwtIssuerConfig`
- `GatewayConfig` has many `IdentityContextRule`

Lifecycle rules:
- Created when a gateway deployment is configured.
- Updated when routing, auth, or audit settings change.
- Deleted only when the gateway deployment is retired.

### 2. Organization
Represents a company or tenant context that upgraded traffic may belong to.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| id | string | yes | n/a | Stable internal identifier. |
| name | string | yes | n/a | Human-readable company or tenant name. |
| status | enum(`active`,`disabled`) | yes | `active` | Disabled organizations cannot use upgraded access. |
| jwt_subject_mapping | string | yes | `org_id` | Default claim or mapping linking JWT requests to this organization. Must remain configurable. |
| created_at | datetime | yes | now | Audit and onboarding support. |
| updated_at | datetime | yes | now | Tracks config edits. |

Relationships:
- One `Organization` has many `ApiClient`
- One `Organization` may be associated with many JWT-authenticated requests through trusted issuer configuration and claims

Lifecycle rules:
- Create when onboarding a company, tenant, or partner context.
- Update name, status, or claim mapping as the relationship evolves.
- Disable rather than hard-delete when historical audit needs to stay readable.

### 3. ApiClient
Represents a non-browser or partner consumer authenticated by API key.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| id | string | yes | n/a | Stable internal identifier. |
| organization_id | string | yes | n/a | Company or tenant that owns the API client. |
| name | string | yes | n/a | Human-readable client name. |
| api_key_hash | string | yes | n/a | Hashed API key value used for comparison in the MVP. |
| key_prefix | string | no | none | Non-sensitive prefix for debugging and support workflows. |
| hash_algorithm | string | yes | `SHA-256` | Records the hashing approach used for verification. |
| scopes | string[] | yes | `[]` | Allowed scopes granted to this client. |
| status | enum(`active`,`disabled`) | yes | `active` | Disabled clients cannot authenticate. |
| created_at | datetime | yes | now | Audit and rotation support. |
| updated_at | datetime | yes | now | Tracks config edits. |

Relationships:
- Many `ApiClient` records belong to one `Organization`.
- Many `ApiClient` records may use the same `RateLimitTier` by convention, but in the MVP the tier is selected by request class rather than per client reference.

Lifecycle rules:
- Create when onboarding a partner or service consumer.
- Update name, scopes, or status as access changes.
- Disable rather than hard-delete if historical audit logs must remain understandable.

Integrity rules:
- API keys are modeled as separate client credentials within an organization.

### 4. JwtIssuerConfig
Represents one JWT validation rule set for logged-in traffic in the MVP. JWT support is part of the first working implementation, not a later enhancement, and the MVP must support multiple issuers and audiences.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| id | string | yes | n/a | Stable identifier for the issuer config. |
| enabled | boolean | yes | `true` | JWT support exists in the MVP implementation, even if a deployment can still choose how to configure it. |
| issuer | string | yes | n/a | Expected `iss` claim. |
| audiences | string[] | yes | n/a | One issuer may allow multiple audiences. |
| header_name | string | yes | `"authorization"` | Header that carries the token. |
| scheme | string | no | `"Bearer"` | Optional prefix before the token. |
| verification_mode | enum(`shared_secret`) | yes | `shared_secret` | Keep MVP narrow. |
| shared_secret | string | conditional | none | Required when `verification_mode = shared_secret`. |
| claim_to_subject | string | yes | `"sub"` | Claim used as the stable identity subject. |
| claim_to_organization | string | yes | `org_id` | Claim or mapping used to derive organization or tenant context from the JWT. |
| required_claims | string[] | yes | `["iss","aud","exp","sub","unique_user_id"]` | Recommended required claims for upgraded JWT access in the MVP. |
| optional_claims | string[] | yes | `["scope"]` | Extra claims that may be used when a deployment opts into them. |

Relationships:
- `GatewayConfig` has many `JwtIssuerConfig`

Lifecycle rules:
- Can be disabled without deleting the record.
- Updated whenever identity provider settings change.

Integrity rules:
- `issuer` identifies the auth system that signed the JWT, not the end user or partner account represented inside it.
- `iss`, `aud`, `exp`, `sub`, and `unique_user_id` are required for the recommended MVP JWT path.
- JWT-authenticated requests are expected to resolve to an organization or tenant context.
- The default organization claim is `org_id`, but deployments must be able to configure a different claim or mapping.
- If a JWT resolves to a disabled organization, the request is blocked by default.
- `scope` is optional in the MVP.

### 5. IdentityContextRule
Represents optional developer-defined identity context that may accompany authenticated requests.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| id | string | yes | n/a | Stable identifier for the context rule. |
| header_name | string | no | none | Header name carrying the secondary identifier when headers are used. |
| required_for_modes | enum[] | yes | `["jwt"]` | Which access modes require this extra identifier. |
| value_description | string | yes | `unique_user_id` | Plain description of the stable paid-tier identifier. |
| trusted_source | enum(`request_header`,`jwt_claim`) | yes | `jwt_claim` | Whether the value comes from a request header or directly from the JWT. |
| missing_value_behavior | enum(`reject`,`allow`,`downgrade`) | yes | `reject` | Default behavior when the required identifier is missing. |
| uniqueness_scope | enum(`global`,`organization`) | yes | `global` | Defines whether the identifier is globally unique or scoped under an organization. |
| enabled | boolean | yes | `true` | Allows optional rollout by environment. |

Relationships:
- Many `IdentityContextRule` records belong to one `GatewayConfig`

Lifecycle rules:
- Create when a deployment needs extra identity context beyond JWT or API key.
- Update when the identifier format or trusted source changes.
- Disable when no longer needed.

Integrity rules:
- The default trusted source is a JWT claim.
- `unique_user_id` is globally unique by default in the MVP.
- When required and missing, the request is rejected by default.

### 6. RoutePolicy
Represents the access rule for a path prefix.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| id | string | yes | n/a | Stable identifier for referencing and editing. |
| path_prefix | string | yes | n/a | Prefix match against the incoming request path. |
| access_mode | enum(`public`,`authenticated`,`api_key`,`jwt`) | yes | `api_key` | Default should stay secure. |
| required_scopes | string[] | yes | `[]` | Must all be present on the resolved identity. |
| rate_limit_tier_key | string | no | none | Optional future hook for per-route overrides. |
| enabled | boolean | yes | `true` | Disabled rules are ignored. |

Relationships:
- Many `RoutePolicy` records belong to one `GatewayConfig`

Lifecycle rules:
- Create when protecting a new path family.
- Update as access requirements evolve.
- Disable or delete when that route no longer needs protection.

Integrity rules:
- Longest matching `path_prefix` wins.
- If `access_mode = public`, requests may proceed without credentials.
- If `access_mode = authenticated`, a valid API key or JWT must be present.
- If `access_mode = api_key`, only API-key identities satisfy the rule.
- If `access_mode = jwt`, only JWT identities satisfy the rule.
- JWT-based access does not require an API key in the MVP.
- If both JWT and API key are presented together, mismatch should be denied by default unless configuration explicitly says otherwise.
- Default JWT/API-key matching means same organization and same user identity.

### 7. RateLimitTier
Represents a quota bucket applied to a request class.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| key | enum(`free`,`upgraded`) | yes | n/a | The MVP uses a free tier and an upgraded tier. |
| points | number | yes | n/a | Max requests allowed in the window. |
| duration_seconds | number | yes | n/a | Window size in seconds. |
| subject_basis | enum(`ip`,`identity`,`api_key`) | yes | n/a | Free-tier traffic is usually keyed by IP; upgraded traffic may be keyed by JWT identity or API key. |
| eligibility_rule | enum(`anonymous`,`jwt`,`api_key`,`any_authenticated`) | yes | n/a | Defines which request class enters the tier. |

Relationships:
- `GatewayConfig` has many `RateLimitTier`

Lifecycle rules:
- Create exactly two tiers in the MVP: `free` and `upgraded`.
- Update values as abuse patterns and usage evolve.

Integrity rules:
- `points` must be greater than zero.
- `duration_seconds` must be greater than zero.
- `upgraded` must accept both `jwt` and `api_key` callers in the MVP design.
- JWT callers and API-key callers are independent upgraded authentication paths.
- API-key upgraded traffic is rate-limited per API key by default.
- The example app defaults are `10` requests per `86400` seconds for `free` and `1000` requests per `86400` seconds for `upgraded`.

### 8. AuditEvent
Represents the immutable record of request handling.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| id | string or integer | yes | generated | Primary key. |
| occurred_at | datetime | yes | now | When the gateway handled the request. |
| client_type | enum(`anonymous`,`api_key`,`jwt`) | yes | n/a | How the caller was identified. |
| organization_id | string | no | none | Resolved company or tenant context when present. |
| client_name | string | no | none | Partner name or resolved identity label when available. |
| client_subject | string | no | none | API key id, JWT `sub`, or anonymous marker. |
| identity_context_value | string | no | none | Optional developer-defined secondary identifier, such as `unique_user_id`. |
| matched_route_policy_id | string | yes | n/a | The `RoutePolicy` selected for the request. |
| method | string | yes | n/a | HTTP method. |
| path | string | yes | n/a | Requested path. |
| status_code | number | yes | n/a | Final response code returned to the caller. |
| latency_ms | number | yes | n/a | End-to-end handling time. |
| source_ip | string | no | none | Client IP when available. |
| outcome | enum(`allowed`,`blocked`) | yes | n/a | Whether the gateway forwarded the request. |
| block_reason | enum(`auth`,`scope`,`rate_limit`,`ip_policy`,`upstream_error`) | no | none | Present only when relevant. |
| jwt_claim_snapshot | object | no | none | Selected JWT claim values kept for debugging when JWT auth is used. Default snapshot should include `iss`, `aud`, `sub`, `org_id`, and `unique_user_id`. |

Relationships:
- `AuditEvent` belongs logically to one `GatewayConfig`
- `AuditEvent` references one matched `RoutePolicy` by stored identifier

Lifecycle rules:
- Created for every handled request.
- Never updated for business logic reasons.
- Retained or archived according to an as-yet undefined retention policy.

Integrity rules:
- Audit records are append-only.
- `block_reason` must be null when `outcome = allowed`.

## MVP Invariants
- Every incoming request maps to exactly one effective `RoutePolicy`.
- A request is evaluated in this order: identity, route access, scopes, rate tier selection, rate limiting, upstream forwarding, audit logging.
- A request that fails a policy check must still be auditable.
- Free-tier traffic and upgraded traffic must be rate-limited independently.
- Scope checks only apply after an identity has been resolved.
- IP address is used for free-tier throttling, not for MVP allow/deny access control.
- Logged-in first-party users may become upgraded traffic through JWT alone, or JWT plus an optional developer-defined secondary identifier.
- API-key traffic and JWT traffic are separate upgraded authentication options; one does not imply the other.
- If both JWT and API key are present, default behavior is deny on mismatch.

## Example App Notes
- The MVP example app uses one demo organization with multiple demo users.
- The MVP example app exposes `GET /api`.
- Upgraded `/api` responses should visibly indicate paid-tier access.
- The upgraded response should keep the same shape as the free-tier response with one extra paid-tier field.
- Demo login should use username and password input and store the JWT in a cookie.
- Caller-specific "last successful access" display is an example-app behavior and should be handled in browser-local storage rather than OpenGate core state.

## Later Model
These are likely useful, but should stay out of the MVP unless Step 3 requires them.

### Deferred entities or upgrades
- `ApiClientSecretVersion`: for key rotation history beyond the first hashed-key version.
- `JwtProviderKeySet`: for JWKS-based verification and richer key rotation.
- `RouteRateLimitOverride`: for route-specific quota policies rather than only global public/authenticated tiers.
- `IpRangeRule`: if IP-based allow/deny policies are introduced later.
- `AuditRetentionPolicy`: for explicit purge or archive rules.
- `ConsumerGroup`: for grouping multiple clients under shared policies.
- `RequestCorrelation`: for request ids, trace ids, and upstream correlation metadata.

## Review Notes
The current direction is now clearer: JWT support is part of the MVP implementation, API keys are hashed from the start, audit events store matched route-policy ids, multiple JWT issuers are expected, and the free-vs-upgraded tier split is based on caller identity state rather than IP allow lists. JWT-based upgraded access is now its own sufficient auth path and does not require an API key.

For the MVP, JWT verification will use shared secrets to keep implementation scope small. For production-oriented evolution, the expected direction is to move to asymmetric verification.

The example implementation should stay clearly separated from the OpenGate product itself. It should live in its own folder, expose a simple `/api` example route, keep the underlying endpoint hidden behind OpenGate, and demonstrate the full story: free-tier access, upgraded JWT access with `unique_user_id`, rate limiting, and audit logging.

## Open Questions
None at the Step 2 data-model level right now.

