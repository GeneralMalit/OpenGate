import type { Application as ExpressApplication, Request as ExpressRequest, Response as ExpressResponse, Router } from "express";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export type HttpMethod =
  | "CONNECT"
  | "DELETE"
  | "GET"
  | "HEAD"
  | "OPTIONS"
  | "PATCH"
  | "POST"
  | "PUT"
  | "TRACE";

export type AccessMode = "public" | "authenticated" | "jwt" | "api_key";
export type IdentityType = "anonymous" | "jwt" | "api_key";
export type TierName = "free" | "upgraded";
export type OutcomeType = "allowed" | "blocked";
export type JwtVerificationMode = "shared_secret" | "jwks";
export type ObservabilityConfig = {
  requestIdHeader?: string;
  healthPath?: string;
  readyPath?: string;
  metricsPath?: string;
  statusPath?: string;
};

export type OpenGateLogLevel = "info" | "warn" | "error";

export type OpenGateLogEvent = {
  timestamp: string;
  level: OpenGateLogLevel;
  event:
    | "request.completed"
    | "request.blocked"
    | "request.allowed"
    | "audit.write.failed"
    | "audit.write.dropped"
    | "health.check"
    | "ready.check";
  requestId: string;
  routePolicyId?: string;
  method?: string;
  path?: string;
  identityType?: IdentityType;
  tier?: TierName;
  statusCode?: number;
  outcome?: OutcomeType;
  blockReason?: string | null;
  latencyMs?: number;
  message?: string;
  details?: Record<string, unknown>;
};

export type OpenGateLoggerAdapter = {
  emit: (event: OpenGateLogEvent) => void | Promise<void>;
  close?: () => Promise<void> | void;
};

export type OrganizationConfig = {
  id: string;
  name: string;
  enabled?: boolean;
};

export type UserConfig = {
  id: string;
  name: string;
  organizationId: string;
  email?: string;
  enabled?: boolean;
};

export type SharedSecretJwtIssuerConfig = {
  issuer: string;
  audiences: string[];
  enabled?: boolean;
  verificationMode?: "shared_secret";
  sharedSecret: string;
  organizationClaim?: string;
  subjectClaim?: string;
  requiredClaims?: string[];
  optionalClaims?: string[];
};

export type JwksJwtIssuerConfig = {
  issuer: string;
  audiences: string[];
  enabled?: boolean;
  verificationMode: "jwks";
  jwksUrl: string;
  allowedAlgorithms: string[];
  cacheTtlMs?: number;
  requestTimeoutMs?: number;
  organizationClaim?: string;
  subjectClaim?: string;
  requiredClaims?: string[];
  optionalClaims?: string[];
};

export type JwtIssuerConfig = SharedSecretJwtIssuerConfig | JwksJwtIssuerConfig;

export type JwtConfig = {
  cookieName?: string;
  issuers: JwtIssuerConfig[];
};

export type ApiKeyVersionConfig = {
  id: string;
  keyHash: string;
  createdAt: string;
  notBefore?: string;
  expiresAt?: string;
  revokedAt?: string;
  enabled?: boolean;
};

export type ApiClientConfig = {
  id: string;
  name: string;
  organizationId: string;
  userId: string;
  keyHash?: string;
  keyVersions?: ApiKeyVersionConfig[];
  scopes?: string[];
  enabled?: boolean;
};

export type ApiKeysConfig = {
  headerName: string;
  clients: ApiClientConfig[];
};

export type RoutePolicyConfig = {
  id: string;
  pathPrefix: string;
  accessMode: AccessMode;
  requiredScopes?: string[];
  enabled?: boolean;
};

export type RateLimitTierConfig = {
  points: number;
  duration: "calendar_day";
};

export type RateLimitConfig = {
  store?: "memory" | "redis";
  redisUrl?: string;
  redisKeyPrefix?: string;
  redisKeyExpirySeconds?: number;
  timezone?: string;
  free: RateLimitTierConfig;
  upgraded: RateLimitTierConfig;
};

export type OpenGateRouteMetricSnapshot = {
  routePolicyId: string;
  requests: number;
  allowed: number;
  blocked: number;
  authFailures: number;
  rateLimited: number;
  auditWrites: number;
  auditFailures: number;
  auditDropped: number;
};

export type OpenGateMetricsSnapshot = {
  requestsTotal: number;
  allowedTotal: number;
  blockedTotal: number;
  authFailuresTotal: number;
  rateLimitedTotal: number;
  auditWritesTotal: number;
  auditFailuresTotal: number;
  auditDroppedTotal: number;
  healthChecksTotal: number;
  readyChecksTotal: number;
  routes: OpenGateRouteMetricSnapshot[];
};

export type OpenGateStatusSnapshot = {
  status: "ready";
  startedAt: string;
  uptimeMs: number;
  requestIdHeader: string;
  backends: {
    rateLimits: "memory" | "redis";
    audit: "sqlite" | "postgres";
  };
  metrics: OpenGateMetricsSnapshot;
};

export type AuditConfig = {
  enabled: boolean;
  backend?: "sqlite" | "postgres";
  sqlitePath: string;
  postgresUrl?: string;
  postgresTable?: string;
  flushIntervalMs?: number;
  maxQueueSize?: number;
  batchSize?: number;
  jwtClaimSnapshot?: string[];
};

export type BehaviorConfig = {
  onMissingSecondaryIdentifier?: "reject" | "allow";
  onCredentialMismatch?: "deny" | "prefer_jwt";
  onDisabledOrganization?: "block" | "allow";
  onDisabledUser?: "block" | "allow";
};

export type IdentityContextRuleConfig = {
  source: "jwt_claim";
  claim: string;
  required?: boolean;
  globalUniqueness?: "global" | "organization";
};

export type OpenGateConfig = {
  organizations: OrganizationConfig[];
  users?: UserConfig[];
  jwt: JwtConfig;
  apiKeys: ApiKeysConfig;
  identityContext: IdentityContextRuleConfig;
  routePolicies: RoutePolicyConfig[];
  rateLimits: RateLimitConfig;
  audit: AuditConfig;
  observability?: ObservabilityConfig;
  behavior?: BehaviorConfig;
};

export type ResolvedRoutePolicy = {
  id: string;
  pathPrefix: string;
  accessMode: AccessMode;
  requiredScopes: string[];
  enabled: boolean;
};

export type ProtectedRouteHandler<RequestLike, ReplyLike> = (request: RequestLike, reply: ReplyLike) => unknown | Promise<unknown>;

export type BaseRegisterProtectedRouteConfig<RequestLike, ReplyLike> = {
  path: string;
  method: HttpMethod;
  handler: ProtectedRouteHandler<RequestLike, ReplyLike>;
  policyId?: string;
  accessMode?: AccessMode;
  requiredScopes?: string[];
  enabled?: boolean;
};

export type JwtIdentity = {
  identityType: "jwt";
  tier: "upgraded";
  organizationId: string;
  subject: string;
  secondaryIdentifier: string;
  scopes: string[];
  rateLimitSubject: string;
  jwtClaims: Record<string, unknown>;
  issuer: string;
};

export type ApiKeyIdentity = {
  identityType: "api_key";
  tier: "upgraded";
  organizationId: string;
  subject: string;
  secondaryIdentifier: string;
  scopes: string[];
  rateLimitSubject: string;
  apiClientId: string;
  apiKeyVersionId: string;
};

export type AnonymousIdentity = {
  identityType: "anonymous";
  tier: "free";
  scopes: string[];
  rateLimitSubject: string;
};

export type RequestIdentity = JwtIdentity | ApiKeyIdentity | AnonymousIdentity;

export type OpenGateRequestContext = {
  startedAt: bigint;
  requestId: string;
  routePolicy: ResolvedRoutePolicy;
  identity: RequestIdentity;
  outcome: OutcomeType;
  blockReason: string | null;
  jwtClaimSnapshot: Record<string, unknown> | null;
  auditLogged: boolean;
};

export type FastifyRegisterProtectedRouteConfig = BaseRegisterProtectedRouteConfig<FastifyRequest, FastifyReply> & {
  gate: FastifyOpenGate;
};

export type ExpressRegisterProtectedRouteConfig = BaseRegisterProtectedRouteConfig<ExpressRequest, ExpressResponse> & {
  gate: ExpressOpenGate;
};

export type RegisterProtectedRouteConfig = FastifyRegisterProtectedRouteConfig;

export type AuditEvent = {
  occurredAt: string;
  requestId: string;
  routePolicyId: string;
  identityType: IdentityType;
  organizationId: string | null;
  secondaryIdentifier: string | null;
  method: string;
  path: string;
  statusCode: number;
  latencyMs: number;
  outcome: OutcomeType;
  blockReason: string | null;
  jwtClaimSnapshot: Record<string, unknown> | null;
};

export type RateLimitResult =
  | {
      allowed: true;
      limit: number;
      remaining: number;
      resetBucket: string;
    }
  | {
      allowed: false;
      limit: number;
      remaining: number;
      resetBucket: string;
    };

export type RateLimitStore = {
  consume: (bucketKey: string, subjectKey: string, limit: number) => RateLimitResult | Promise<RateLimitResult>;
  close?: () => Promise<void> | void;
};

export type CreateOpenGateOptions = {
  config?: OpenGateConfig;
  configPath?: string;
  rateLimitStore?: RateLimitStore;
  logger?: OpenGateLoggerAdapter;
};

export type OperationalRoutesConfig = {
  healthPath?: string;
  readyPath?: string;
  metricsPath?: string;
  statusPath?: string;
};

export type FastifyOpenGate = {
  config: OpenGateConfig;
  registerProtectedRoute: (
    app: FastifyInstance,
    routeConfig: Omit<FastifyRegisterProtectedRouteConfig, "gate">
  ) => void;
  registerOperationalRoutes: (
    app: FastifyInstance,
    routeConfig?: Omit<FastifyOperationalRoutesConfig, "gate">
  ) => void;
  close: () => Promise<void> | void;
};

export type ExpressOpenGate = {
  config: OpenGateConfig;
  registerProtectedRoute: (
    app: ExpressApplication | Router,
    routeConfig: Omit<ExpressRegisterProtectedRouteConfig, "gate">
  ) => void;
  registerOperationalRoutes: (
    app: ExpressApplication | Router,
    routeConfig?: Omit<ExpressOperationalRoutesConfig, "gate">
  ) => void;
  close: () => Promise<void> | void;
};

export type OpenGate = FastifyOpenGate;

export type FastifyOperationalRoutesConfig = OperationalRoutesConfig & {
  gate: FastifyOpenGate;
};

export type ExpressOperationalRoutesConfig = OperationalRoutesConfig & {
  gate: ExpressOpenGate;
};
