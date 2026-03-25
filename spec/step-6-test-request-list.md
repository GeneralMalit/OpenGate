# Step 6 - Test Request List

## Purpose
This is the test-first request list for OpenGate MVP. The tests below are ordered to cover the happy path first, then the highest-risk edge cases, then the example-app integration path.

Each requested test includes:
- the behavior to verify
- the Step 4 requirement mapping
- a short QA justification comment

## Priority 1 - Core Happy Path

### Test 1 - Public free-tier request is allowed through a `public` route
- Verify that an anonymous `GET /api` request to a `public` route is classified as free-tier traffic, reaches the protected handler, and returns the handler response.
- Maps to spec: `4`, `5`, `23`, `24`, `35`, `36`, `58`, `60`, `61`, `75`, `76`
- QA comment: This is the baseline success path for the product. If this fails, the MVP is not usable as a drop-in gate.

### Test 2 - Valid upgraded JWT request is allowed without an API key
- Verify that a request with a valid shared-secret JWT containing `iss`, `aud`, `exp`, `sub`, `org_id`, and `unique_user_id` is accepted on a `jwt` route without requiring an API key.
- Maps to spec: `6`, `8`, `9`, `10`, `11`, `13`, `14`, `15`, `16`, `18`, `28`
- QA comment: This proves the central upgraded-user flow and confirms that JWT is its own sufficient auth path.

### Test 3 - Valid API-key request is allowed on an API-key route
- Verify that a request with a correctly hashed and matched API key is accepted on an `api_key` route and reaches the protected handler.
- Maps to spec: `7`, `20`, `21`, `22`, `25`, `29`, `60`
- QA comment: This covers the second upgraded access path and makes sure partner/server-to-server support actually works.

### Test 4 - Higher-level route registration helper protects a hidden handler
- Verify that the default route helper accepts a handler plus route-config object and can keep the underlying handler inaccessible except through OpenGate.
- Maps to spec: `1`, `2`, `3`, `62`, `63`, `64`, `65`
- QA comment: This is the installability story. If this is awkward or broken, the library-first design breaks down.

## Priority 2 - Authentication and Policy Edge Cases

### Test 5 - Missing required JWT claim is rejected
- Verify that a JWT request missing `unique_user_id` is rejected by default.
- Maps to spec: `11`, `15`, `16`, `17`, `18`
- QA comment: This protects the upgraded tier from partial or weak identity data.

### Test 6 - Disabled organization JWT request is blocked
- Verify that a valid JWT resolving to a disabled organization is blocked before the protected handler runs.
- Maps to spec: `13`, `14`, `33`, `61`
- QA comment: This is a high-risk authorization boundary and should fail closed.

### Test 7 - JWT and API key mismatch is denied by default
- Verify that when both JWT and API key are present and they do not resolve to the same organization and user identity, the request is denied.
- Maps to spec: `30`, `31`, `32`
- QA comment: Mixed-credential cases are a common place for auth bugs, so this should be locked down early.

### Test 8 - Matching JWT and API key on an `authenticated` route prefer JWT as primary identity
- Verify that when both credentials are valid and match, OpenGate treats JWT as the primary identity for audit and rate-limiting decisions.
- Maps to spec: `27`, `31`, `66`
- QA comment: This ensures the conflict-resolution rule is deterministic and testable.

### Test 9 - Longest-prefix route policy wins
- Verify that when two route policies match the same path, the longest path prefix is selected.
- Maps to spec: `23`, `24`
- QA comment: Route matching bugs can silently apply the wrong policy, so this is a core routing safety test.

### Test 10 - Optional scope enforcement blocks insufficient scope
- Verify that when a route requires scope and the resolved identity lacks it, the request is blocked.
- Maps to spec: `12`, `34`, `61`
- QA comment: This confirms scope checks only happen when configured and still fail safely.

## Priority 3 - Tiering and Rate Limiting

### Test 11 - Free-tier requests are rate-limited by IP
- Verify that anonymous requests share free-tier quota by IP and are rejected with `429` after exceeding the configured daily limit.
- Maps to spec: `35`, `36`, `41`, `42`, `43`, `68`
- QA comment: This validates the most abuse-prone path in the system.

### Test 12 - Upgraded JWT requests are rate-limited by resolved identity
- Verify that upgraded JWT requests consume quota by identity rather than by IP.
- Maps to spec: `35`, `37`, `41`, `42`
- QA comment: This ensures logged-in users get identity-based rate limiting instead of anonymous bucketing.

### Test 13 - Upgraded API-key requests are rate-limited per API key
- Verify that two different API keys in the same organization have separate upgraded rate-limit counters.
- Maps to spec: `38`, `41`
- QA comment: This protects the intended per-user/per-key isolation for partner-style access.

### Test 14 - Calendar-day limit resets respect configured timezone
- Verify that daily rate limits reset on calendar-day boundaries and default to `UTC` when no timezone override is configured.
- Maps to spec: `41`, `68`
- QA comment: Time-based limits are easy to get subtly wrong, and bugs here can be hard to spot after the fact.

### Test 15 - Default rejection status codes are reason-specific
- Verify that rate-limit failures return `429`, auth failures return appropriate specific codes when clear, and unspecified deny paths fall back to `403`.
- Maps to spec: `42`, `43`, `44`, `45`
- QA comment: This keeps error handling predictable for integrators and avoids inconsistent response behavior.

## Priority 4 - Audit and Persistence

### Test 16 - Allowed request writes an audit row with required core fields
- Verify that an allowed request writes an append-only SQLite audit row containing route-policy id, identity type, organization context when available, method, path, status code, latency, and outcome.
- Maps to spec: `47`, `48`, `50`, `51`, `52`, `53`, `57`
- QA comment: Auditability is one of the main reasons OpenGate exists, so the success path must be recorded correctly.

### Test 17 - Blocked request writes an audit row with block reason
- Verify that a blocked request still writes an audit row and includes the blocking outcome metadata.
- Maps to spec: `47`, `49`, `53`, `57`, `61`
- QA comment: Security-relevant failures are often more important to log than successes.

### Test 18 - JWT audit claim snapshot stores the selected default claims
- Verify that JWT-authenticated requests persist the default debug claim snapshot containing `iss`, `aud`, `sub`, `org_id`, and `unique_user_id`.
- Maps to spec: `55`, `56`
- QA comment: This confirms the debug logging contract without expanding into arbitrary claim logging.

### Test 19 - Audit log is append-only during normal request handling
- Verify that repeated requests create new audit rows rather than mutating prior rows.
- Maps to spec: `57`
- QA comment: Append-only behavior is foundational for trustworthy request history.

## Priority 5 - Example App Integration

### Test 20 - Example app supports username/password demo login and sets an `HttpOnly` JWT cookie
- Verify that the demo login flow accepts username/password input for a demo user and establishes upgraded auth using an `HttpOnly` cookie.
- Maps to spec: `70`, `71`, `72`, `74`
- QA comment: This proves the example app demonstrates a realistic-enough industry-style flow.

### Test 21 - Logout returns the example app to free-tier behavior
- Verify that logging out clears upgraded access and subsequent `GET /api` requests behave as free-tier traffic.
- Maps to spec: `73`
- QA comment: This ensures the demo clearly shows the tier transition in both directions.

### Test 22 - Example app `GET /api` keeps the same base JSON shape across tiers
- Verify that free-tier and upgraded-tier responses share the same base JSON shape, with upgraded responses adding only one paid-tier field.
- Maps to spec: `75`, `76`, `77`, `78`
- QA comment: This keeps the demo understandable and proves the intended user-facing contract.

### Test 23 - Example app demonstrates end-to-end OpenGate behavior on `/api`
- Verify the end-to-end demo path: anonymous access, upgraded access after login, rate limiting, and audit logging all work together through the public `/api` route.
- Maps to spec: `69`, `75`, `76`, `79`
- QA comment: This is the final confidence test that the product story matches what the README and specs promise.

## Optional Test

### Test 24 - Browser-local last-successful-access display works independently from OpenGate core
- Verify that the example app can display the caller's last successful access time using browser-local state without requiring OpenGate core to manage that state.
- Maps to spec: `80`
- QA comment: This is useful for the demo, but it is intentionally lower priority because it is not part of OpenGate core behavior.

## Recommended First Test Batch
If we want the smallest strong starting set before implementation grows, begin with:
1. Test 1 - Public free-tier request is allowed
2. Test 2 - Valid upgraded JWT request is allowed without an API key
3. Test 6 - Disabled organization JWT request is blocked
4. Test 7 - JWT and API key mismatch is denied by default
5. Test 11 - Free-tier requests are rate-limited by IP
6. Test 16 - Allowed request writes an audit row with required core fields
7. Test 20 - Example app login sets an `HttpOnly` JWT cookie
8. Test 23 - Example app demonstrates end-to-end OpenGate behavior on `/api`
