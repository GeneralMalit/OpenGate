# Step 1 - Problem Frame

## Goal
OpenGate is an open-source middleware layer for websites that expose API endpoints such as `website.com/api`, so those endpoints can be protected without rewriting the service behind them.

## Business Value
- Lets teams expose API endpoints more safely to the public or to private partners.
- Reduces abuse such as request flooding, unauthorized access, and accidental overload.
- Gives smaller teams a practical and configurable security layer without buying a large platform.
- Makes API protection easier to adopt, especially for first-time website creators.

## Success Metrics
- A site with an existing API endpoint can place OpenGate in front of it and get basic protection working in about an hour.
- Requests can be checked, allowed, blocked, forwarded, and logged end to end.
- Public users and logged-in users can be given different request limits.
- API access can be restricted by route, authentication status, and optional IP rules.
- OpenGate can sit in front of an existing service without major upstream changes.

## Constraints
- Must work as a drop-in middleware layer in front of existing HTTP API endpoints.
- Must not require rewriting the upstream service.
- Must support configurable API key headers and JWT-based identity checks.
- Must support different request limits for different user groups.
- Must keep the first version small, easy to apply, and fast enough that it does not feel present during normal use.
- Must be designed for API endpoints on websites, not as a full platform product.
- Browser cross-site request support is not part of this step yet; if a frontend page on another domain needs special browser permission handling, that is a later limitation to solve.

## User Story
As a system architect, I want to protect specific API endpoints with configurable access rules, so that public users and private partners can be given different levels of access without changing the upstream service.

## Acceptance Criteria
- A valid request can pass through OpenGate to the upstream API.
- A request without valid authentication is treated as unauthenticated and restricted accordingly.
- A request that does not meet policy or route rules is blocked.
- A request that exceeds the request limit is blocked.
- A request from a disallowed IP is blocked when IP filtering is enabled.
- A handled request creates an audit record.
- Logged-in users can receive a higher daily request limit than unauthenticated users.
- The system can be configured so different endpoints can have different access rules.

## Inputs and Outputs
### Inputs
- Incoming HTTP request path, method, headers, and body.
- API key in a configurable header.
- JWT in a header when identity-based access is enabled.
- Optional source IP address.
- Route rules and access requirements.
- Request limit rules for public and logged-in users.
- Audit storage location.
- Upstream target URL.

### Outputs
- Forwarded request and response from the upstream API.
- Rejection response when authentication, policy, or request-limit checks fail.
- Audit record showing what happened to the request.
- Optional browser-facing headers later, if cross-site browser support becomes part of the product.

## Behavior Narrative
1. A client sends a request to a protected API endpoint such as `website.com/api`.
2. OpenGate receives the request and checks the configured headers.
3. If a JWT or API key is present, OpenGate uses it to identify the caller.
4. OpenGate checks whether the request is allowed for that route.
5. OpenGate checks whether the caller is within the allowed request limit.
6. OpenGate checks optional IP rules if they are enabled.
7. If the request is allowed, OpenGate forwards it to the upstream API.
8. OpenGate returns the upstream response to the caller.
9. OpenGate writes an audit record for the request and outcome.

## Risks and Unknowns
- The exact rule format for routes, limits, and user groups may need refinement.
- Audit retention and how long logs should be kept are not yet defined.
- The deployment shape is not yet pinned down.
- The performance target is intentionally high, but the exact latency budget is not yet measured.
- CORS-like browser support is not part of the first step, so browser calls from another domain may not work until that is added later.
- It is not yet clear whether this should stay strictly HTTP-only or later support streaming-style traffic.
