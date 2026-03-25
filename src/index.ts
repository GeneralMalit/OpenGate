export { createAuditLogger } from "./lib/audit.js";
export { authorizeRequest, createApiClientConfig, hashApiKey } from "./lib/auth.js";
export { loadConfig, validateConfig } from "./lib/config.js";
export { createOpenGate, registerProtectedRoute } from "./lib/gate.js";
export { resolveRoutePolicy } from "./lib/policies.js";
export { consumeRateLimit, createRateLimitStore, getCalendarDayBucket } from "./lib/rate_limit.js";
export type {
  AccessMode,
  ApiClientConfig,
  AuditConfig,
  AuditEvent,
  BehaviorConfig,
  CreateOpenGateOptions,
  IdentityContextRuleConfig,
  JwtIssuerConfig,
  OpenGate,
  OpenGateConfig,
  OpenGateRequestContext,
  OrganizationConfig,
  RateLimitConfig,
  RateLimitResult,
  RegisterProtectedRouteConfig,
  RequestIdentity,
  ResolvedRoutePolicy,
  RoutePolicyConfig
} from "./lib/types.js";
