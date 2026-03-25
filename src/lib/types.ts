import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from "fastify";

export type AccessMode = "public" | "authenticated" | "jwt" | "api_key";
export type IdentityType = "anonymous" | "jwt" | "api_key";
export type TierName = "free" | "upgraded";
export type OutcomeType = "allowed" | "blocked";

export type OrganizationConfig = {
  id: string;
  name: string;
  enabled?: boolean;
};

export type JwtIssuerConfig = {
  issuer: string;
  audiences: string[];
  sharedSecret: string;
  organizationClaim?: string;
  subjectClaim?: string;
  requiredClaims?: string[];
  optionalClaims?: string[];
};

export type JwtConfig = {
  cookieName?: string;
  issuers: JwtIssuerConfig[];
};

export type ApiClientConfig = {
  id: string;
  name: string;
  organizationId: string;
  userId: string;
  keyHash: string;
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
  timezone?: string;
  store?: string;
  free: RateLimitTierConfig;
  upgraded: RateLimitTierConfig;
};

export type AuditConfig = {
  enabled: boolean;
  sqlitePath: string;
  jwtClaimSnapshot?: string[];
};

export type BehaviorConfig = {
  onMissingSecondaryIdentifier?: "reject" | "allow";
  onCredentialMismatch?: "deny" | "prefer_jwt";
  onDisabledOrganization?: "block" | "allow";
};

export type IdentityContextRuleConfig = {
  source: "jwt_claim";
  claim: string;
  required?: boolean;
  globalUniqueness?: "global" | "organization";
};

export type OpenGateConfig = {
  organizations: OrganizationConfig[];
  jwt: JwtConfig;
  apiKeys: ApiKeysConfig;
  identityContext: IdentityContextRuleConfig;
  routePolicies: RoutePolicyConfig[];
  rateLimits: RateLimitConfig;
  audit: AuditConfig;
  behavior?: BehaviorConfig;
};

export type ResolvedRoutePolicy = {
  id: string;
  pathPrefix: string;
  accessMode: AccessMode;
  requiredScopes: string[];
  enabled: boolean;
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
  routePolicy: ResolvedRoutePolicy;
  identity: RequestIdentity;
  outcome: OutcomeType;
  blockReason: string | null;
  jwtClaimSnapshot: Record<string, unknown> | null;
  auditLogged: boolean;
};

export type RegisterProtectedRouteConfig = {
  gate: OpenGate;
  path: string;
  method: HTTPMethods;
  handler: (request: FastifyRequest, reply: FastifyReply) => unknown | Promise<unknown>;
  policyId?: string;
  accessMode?: AccessMode;
  requiredScopes?: string[];
  enabled?: boolean;
};

export type AuditEvent = {
  occurredAt: string;
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
  consume: (bucketKey: string, subjectKey: string, limit: number) => RateLimitResult;
};

export type CreateOpenGateOptions = {
  config?: OpenGateConfig;
  configPath?: string;
  rateLimitStore?: RateLimitStore;
};

export type OpenGate = {
  config: OpenGateConfig;
  registerProtectedRoute: (
    app: FastifyInstance,
    routeConfig: Omit<RegisterProtectedRouteConfig, "gate">
  ) => void;
  close: () => void;
};
