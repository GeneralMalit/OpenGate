export {
  createAuditLogger,
  createAuditSink,
  createBufferedAuditLogger,
  createPostgresAuditSink,
  createSqliteAuditSink
} from "./lib/audit.js";
export { authorizeRequest, createApiClientConfig, createApiKeyVersionConfig, hashApiKey } from "./lib/auth.js";
export {
  ConfigValidationError,
  loadConfig,
  migrateConfig,
  validateConfig,
  validateConfigDetailed
} from "./lib/config.js";
export { runCli } from "./lib/cli.js";
export { createExpressOpenGate, registerProtectedRoute as registerExpressProtectedRoute } from "./lib/express_gate.js";
export { createOpenGate, registerProtectedRoute } from "./lib/gate.js";
export { createConsoleLoggerAdapter, createOpenGateTelemetry, resolveOperationalPaths } from "./lib/observability.js";
export { createControlPlane, registerControlPlaneRoutes } from "./lib/control_plane.js";
export { createFastifyOpenGate, registerProtectedRoute as registerFastifyProtectedRoute } from "./fastify.js";
export { resolveRoutePolicy } from "./lib/policies.js";
export { consumeRateLimit, createRateLimitStore, createRedisRateLimitStore, getCalendarDayBucket } from "./lib/rate_limit.js";
export { buildStarterServerSource, createStarterBundle, createDemoApiClient, routeModeToAccessMode } from "./lib/starter.js";
export type {
  AccessMode,
  ApiClientConfig,
  ApiKeyVersionConfig,
  AuditConfig,
  AuditEvent,
  BehaviorConfig,
  CreateOpenGateOptions,
  IdentityContextRuleConfig,
  HttpMethod,
  BaseRegisterProtectedRouteConfig,
  ExpressOpenGate,
  ExpressRegisterProtectedRouteConfig,
  ExpressOperationalRoutesConfig,
  OpenGateLoggerAdapter,
  OpenGateLogEvent,
  OpenGateMetricsSnapshot,
  JwksJwtIssuerConfig,
  JwtIssuerConfig,
  JwtVerificationMode,
  FastifyOpenGate,
  FastifyRegisterProtectedRouteConfig,
  FastifyOperationalRoutesConfig,
  OpenGate,
  OpenGateConfig,
  OpenGateRequestContext,
  OpenGateStatusSnapshot,
  OpenGateRouteMetricSnapshot,
  ObservabilityConfig,
  OrganizationConfig,
  OperationalRoutesConfig,
  RateLimitConfig,
  RateLimitResult,
  RegisterProtectedRouteConfig,
  RequestIdentity,
  ProtectedRouteHandler,
  ResolvedRoutePolicy,
  RoutePolicyConfig,
  SharedSecretJwtIssuerConfig
} from "./lib/types.js";
export type {
  ConfigSource,
  ConfigValidationFailure,
  ConfigValidationIssue,
  ConfigValidationReport,
  ConfigValidationSuccess
} from "./lib/config.js";
export type {
  ControlPlaneLoggerAdapter,
  ControlPlaneLogEvent,
  ControlPlaneMutationResult,
  ControlPlaneRouteOptions,
  ControlPlaneSimulationRequest,
  ControlPlaneSimulationResult,
  ControlPlaneSource,
  ControlPlaneWorkspace,
  ControlPlaneResource,
  IssueApiKeyInput,
  IssueApiKeyResult,
  RotateApiKeyInput,
  RotateApiKeyResult,
  RevokeApiKeyInput
} from "./lib/control_plane.js";
export type { StarterBundleOptions, StarterTemplateName } from "./lib/starter.js";
export type { StarterRouteMode } from "./lib/starter.js";
export type { RequestEnvelope } from "./lib/request.js";
