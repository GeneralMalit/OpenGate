# Step 4 - Formal Spec

## Context
OpenGate is a library-first security gateway for existing website or backend API endpoints. Developers configure it with a local config file and place it in front of selected handlers so free-tier and upgraded-tier traffic can be identified, rate-limited, and audited automatically. The MVP includes a separate example website that demonstrates a hidden `/api` handler protected by OpenGate, with public free-tier access and upgraded JWT access through a fake login flow.

## Functional Requirements
1. The system must be usable as an embedded library inside an existing backend or website server.
2. The system must protect an existing endpoint without requiring the upstream business handler to be rewritten.
3. The system must load its MVP runtime behavior from a local configuration file.
4. The system must support a public free tier and an upgraded tier in the MVP.
5. The system must classify anonymous requests as free-tier traffic by default.
6. The system must support upgraded access through JWT authentication.
7. The system must support upgraded access through API-key authentication as a separate path from JWT authentication.
8. The system must not require an API key when a request is using the JWT authentication path.
9. The system must support multiple JWT issuers and multiple JWT audiences in the MVP configuration.
10. The system must verify shared-secret JWT signatures in the MVP.
11. The system must verify the JWT claims `iss`, `aud`, `exp`, `sub`, and `unique_user_id` for the recommended upgraded JWT path.
12. The system must treat JWT `scope` as optional in the MVP.
13. The system must be able to derive organization or tenant context from JWT claims using configuration.
14. The system must default to using `org_id` as the JWT organization claim while allowing developers to configure a different claim or mapping.
15. The system must support a required secondary identifier for authenticated requests when configured.
16. The system must use a JWT claim as the default source for the required secondary identifier.
17. The system must treat `unique_user_id` as globally unique by default in the MVP.
18. The system must reject a request by default when a required secondary identifier is missing.
19. The system must support configuration that can change the default missing-identifier behavior later.
20. The system must support API-key validation using stored SHA-256 hashes.
21. The system must model API keys as separate client credentials within an organization.
22. The system must support configurable API-key header names.
23. The system must support route policies with path-prefix matching.
24. The system must choose the longest matching route policy when multiple path prefixes match.
25. The system must support route access modes for `public`, `authenticated`, `jwt`, and `api_key`.
26. The system must allow requests through a `public` route without credentials.
27. The system must require a valid JWT or API key for routes configured as `authenticated`.
28. The system must require a valid JWT for routes configured as `jwt`.
29. The system must require a valid API key for routes configured as `api_key`.
30. The system must deny a request by default when both JWT and API key are present but do not match the configured expectation.
31. The default JWT/API-key matching behavior must require the same organization and the same user identity.
32. The system must support configuration that can change the default JWT/API-key mismatch behavior later.
33. The system must block a request by default when a JWT resolves to a disabled organization.
34. The system must support optional scope enforcement on routes.
35. The system must apply different rate limits to free-tier and upgraded-tier traffic.
36. The system must key free-tier limits by IP address in the MVP.
37. The system must key upgraded JWT limits by resolved identity in the MVP.
38. The system must key upgraded API-key limits per API key by default in the MVP.
39. The system must support a configurable rate-limit storage abstraction.
40. The system must default to an in-memory rate-limit store in the MVP.
41. The system must support example default limits of `10` requests per calendar day for free-tier traffic and `1000` requests per calendar day for upgraded traffic.
42. The system must return a rejection response when a request exceeds its configured rate limit.
43. The system must use `429` for rate-limit rejections by default.
44. The system must use reason-specific status codes where clear, and otherwise fall back to `403` by default.
45. The system should use slightly specific default block messages such as `unauthorized`, `forbidden`, and `rate limited` rather than one single generic message for every case.
46. The system must support a simple `rate limited` response in the example app.
47. The system must write audit records to SQLite in the MVP when audit logging is enabled.
48. The system must create an audit record for allowed requests.
49. The system must create an audit record for blocked requests.
50. The audit record must include the matched route-policy identifier.
51. The audit record must include the identity type used for the request.
52. The audit record must include resolved organization or tenant context when available.
53. The audit record must include request method, path, status code, latency, and outcome.
54. The audit record must support storing the secondary identity context value when present.
55. The audit record should support storing selected JWT claim values for debugging.
56. The default JWT audit-claim snapshot should include `iss`, `aud`, `sub`, `org_id`, and `unique_user_id`.
57. The audit record must be append-only for normal MVP operation.
58. The system must allow all IPs by default in the MVP free-tier model.
59. The system must not depend on IP allow-listing to distinguish free-tier from upgraded-tier traffic in the MVP.
60. The system must forward allowed requests to the protected handler and return that handler response to the caller.
61. The system must block disallowed requests before the protected handler runs.
62. The system must make it possible for a host application to keep the protected handler hidden behind OpenGate.
63. The system must provide a higher-level route registration helper as the default integration style for developers.
64. The default route registration helper must accept a handler and a single route-config object that contains route behavior and overrides.
65. The default route registration helper should support the protected-handler registration pattern used by the example app.
66. When both valid JWT and valid API key are present on an `authenticated` route and they match, the system must treat JWT as the default primary identity for auditing and rate limiting.
67. The MVP config file format must be JSON.
68. Calendar-day rate limits must support a configurable reset timezone, with `UTC` as the default.
69. The example website must live in a separate folder from the OpenGate product code.
70. The example website must include a fake login flow that produces upgraded JWT traffic for demonstration.
71. The example website must use username and password entry for demo login.
72. The example website must store the demo JWT in an `HttpOnly` cookie.
73. The example website must include logout that returns the user to free-tier behavior.
74. The example website must use one demo organization with multiple demo users.
75. The example website must expose a single `GET /api` route in the MVP.
76. The example website `/api` route must return the current time and a simple status message.
77. The example website free-tier and upgraded-tier responses must keep the same base JSON shape.
78. The example website upgraded response must add one extra field indicating paid-tier access.
79. The example website must demonstrate the full OpenGate story end to end: free-tier access, upgraded JWT access, rate limiting, and audit logging.
80. The example website may show the caller's last successful access time using browser-local state; this behavior is outside OpenGate core requirements.

## Non-Functional Requirements
- The MVP should be installable and configurable by a developer in about one hour for a simple existing endpoint.
- The library integration should remain small enough that developers do not need to redesign their application architecture to adopt it.
- The system should add low enough overhead that it does not feel meaningfully present during normal local or small-scale usage.
- The system should keep operational complexity low in the MVP by using a local config file, in-memory rate-limit storage by default, and SQLite for audit logs.
- The MVP should optimize for demonstration clarity and developer comprehension over production-scale distribution concerns.
- The system should keep sensitive API-key material non-recoverable by storing hashes instead of raw API keys.
- The production direction should move toward asymmetric JWT verification even though the MVP uses shared-secret verification.
- OpenGate should keep developer setup flexible by providing sensible defaults like `org_id` without forcing rigid claim conventions.
- The example app should use patterns that feel reasonably industry-familiar, such as cookie-based JWT transport, without trying to be a full production auth system.
- The default timezone choice for calendar-day resets should be predictable and portable, so `UTC` is the preferred default.

## Data Requirements
- The MVP data model must include `GatewayConfig`, `Organization`, `ApiClient`, `JwtIssuerConfig`, `IdentityContextRule`, `RoutePolicy`, `RateLimitTier`, and `AuditEvent`.
- `ApiClient.organization_id` must associate API-key credentials with an owning organization.
- `JwtIssuerConfig` must support issuer, audiences, shared secret, subject claim mapping, organization claim mapping, required claims, and optional claims.
- `IdentityContextRule` must support a required `unique_user_id`-style identifier sourced from a JWT claim by default.
- `IdentityContextRule` must support global uniqueness semantics for `unique_user_id` by default.
- `RoutePolicy` must support path prefix, access mode, required scopes, and enabled state.
- `RateLimitTier` must support `free` and `upgraded` tiers with configurable points and duration.
- `AuditEvent` must support organization context, matched route-policy id, and block reason.
- Audit retention policy is not defined in the MVP and is explicitly deferred.

## Out Of Scope
- Standalone reverse-proxy product mode in the MVP.
- Asymmetric JWT verification in the MVP implementation.
- Distributed/shared production rate-limit stores in the example implementation.
- Multi-route demo complexity beyond the single `/api` example.
- Admin UI, analytics dashboard, or tenant management UI.
- Cross-site browser support work.
- Rich external identity-provider integration for the example app.
- Additional tier levels beyond `free` and `upgraded`.

## Assumptions
- The host application can place OpenGate in front of the handler it wants to protect.
- A fake login flow is sufficient to demonstrate upgraded JWT behavior in the example app.
- In-memory rate limiting is acceptable for the MVP demo and single-node development context.
- Developers using the MVP are comfortable editing a local config file.
- Organization or tenant context can be derived from JWT claims using explicit configuration.
- Caller-side last-successful-access display belongs to the example website rather than OpenGate core.

## Open Questions
- No blocking open questions are currently identified at the Step 4 spec level.

