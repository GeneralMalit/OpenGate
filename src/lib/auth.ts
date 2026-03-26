import crypto from "node:crypto";
import type {
  ApiClientConfig,
  ApiKeyVersionConfig,
  OpenGateConfig,
  RequestIdentity,
  ResolvedRoutePolicy
} from "./types.js";
import type { RequestEnvelope } from "./request.js";
import { getHeaderValue } from "./request.js";
import { getJwtVerifier } from "./jwt_verifier.js";

export type AuthorizationDecision =
  | {
      allowed: true;
      identity: RequestIdentity;
      jwtClaimSnapshot: Record<string, unknown> | null;
    }
  | {
      allowed: false;
      identity: RequestIdentity;
      statusCode: number;
      message: string;
      blockReason: string;
      jwtClaimSnapshot: Record<string, unknown> | null;
    };

type JwtAuthResult =
  | {
      ok: true;
      identity: Extract<RequestIdentity, { identityType: "jwt" }>;
      snapshot: Record<string, unknown>;
    }
  | {
      ok: false;
      statusCode: number;
      message: string;
      blockReason: string;
    };

type ApiKeyAuthResult =
  | {
      ok: true;
      identity: Extract<RequestIdentity, { identityType: "api_key" }>;
    }
  | {
      ok: false;
      statusCode: number;
      message: string;
      blockReason: string;
    };

export async function authorizeRequest(
  config: OpenGateConfig,
  policy: ResolvedRoutePolicy,
  request: RequestEnvelope
): Promise<AuthorizationDecision> {
  const anonymousIdentity: RequestIdentity = {
    identityType: "anonymous",
    tier: "free",
    scopes: [],
    rateLimitSubject: request.ip
  };

  if (!policy.enabled) {
    return deny(anonymousIdentity, 403, "forbidden", "policy_disabled", null);
  }

  const jwtToken = extractJwtToken(config, request);
  const apiKey = extractApiKey(config, request);

  const jwtResult = jwtToken ? await verifyJwt(config, jwtToken) : null;
  const apiKeyResult = apiKey ? verifyApiKey(config, apiKey) : null;

  if (jwtResult && !jwtResult.ok) {
    return deny(anonymousIdentity, jwtResult.statusCode, jwtResult.message, jwtResult.blockReason, null);
  }

  if (apiKeyResult && !apiKeyResult.ok) {
    return deny(anonymousIdentity, apiKeyResult.statusCode, apiKeyResult.message, apiKeyResult.blockReason, null);
  }

  const jwtIdentity = jwtResult && jwtResult.ok ? jwtResult.identity : null;
  const apiKeyIdentity = apiKeyResult && apiKeyResult.ok ? apiKeyResult.identity : null;

  if (jwtIdentity && apiKeyIdentity) {
    const matches =
      jwtIdentity.organizationId === apiKeyIdentity.organizationId &&
      jwtIdentity.secondaryIdentifier === apiKeyIdentity.secondaryIdentifier;

    if (!matches && (config.behavior?.onCredentialMismatch ?? "deny") === "deny") {
      return deny(jwtIdentity, 403, "forbidden", "credential_mismatch", jwtResult?.ok ? jwtResult.snapshot : null);
    }

    if (matches || (config.behavior?.onCredentialMismatch ?? "deny") === "prefer_jwt") {
      const scopeDecision = enforceScopes(policy, jwtIdentity);
      if (!scopeDecision.allowed) {
        return deny(jwtIdentity, scopeDecision.statusCode, scopeDecision.message, scopeDecision.blockReason, jwtResult?.ok ? jwtResult.snapshot : null);
      }

      return {
        allowed: true,
        identity: jwtIdentity,
        jwtClaimSnapshot: jwtResult?.ok ? jwtResult.snapshot : null
      };
    }
  }

  if (policy.accessMode === "jwt") {
    if (!jwtIdentity) {
      return deny(anonymousIdentity, 401, "unauthorized", "jwt_required", null);
    }

    const scopeDecision = enforceScopes(policy, jwtIdentity);
    if (!scopeDecision.allowed) {
      return deny(jwtIdentity, scopeDecision.statusCode, scopeDecision.message, scopeDecision.blockReason, jwtResult?.ok ? jwtResult.snapshot : null);
    }

    return {
      allowed: true,
      identity: jwtIdentity,
      jwtClaimSnapshot: jwtResult?.ok ? jwtResult.snapshot : null
    };
  }

  if (policy.accessMode === "api_key") {
    if (!apiKeyIdentity) {
      return deny(anonymousIdentity, 401, "unauthorized", "api_key_required", null);
    }

    const scopeDecision = enforceScopes(policy, apiKeyIdentity);
    if (!scopeDecision.allowed) {
      return deny(apiKeyIdentity, scopeDecision.statusCode, scopeDecision.message, scopeDecision.blockReason, null);
    }

    return {
      allowed: true,
      identity: apiKeyIdentity,
      jwtClaimSnapshot: null
    };
  }

  if (policy.accessMode === "authenticated") {
    const identity = jwtIdentity ?? apiKeyIdentity;

    if (!identity) {
      return deny(anonymousIdentity, 401, "unauthorized", "authenticated_required", null);
    }

    const scopeDecision = enforceScopes(policy, identity);
    if (!scopeDecision.allowed) {
      return deny(identity, scopeDecision.statusCode, scopeDecision.message, scopeDecision.blockReason, jwtResult?.ok ? jwtResult.snapshot : null);
    }

    return {
      allowed: true,
      identity,
      jwtClaimSnapshot: jwtResult?.ok ? jwtResult.snapshot : null
    };
  }

  if (policy.accessMode === "public") {
    const identity = jwtIdentity ?? apiKeyIdentity ?? anonymousIdentity;
    const scopeDecision = enforceScopes(policy, identity);
    if (!scopeDecision.allowed) {
      return deny(identity, scopeDecision.statusCode, scopeDecision.message, scopeDecision.blockReason, jwtResult?.ok ? jwtResult.snapshot : null);
    }

    return {
      allowed: true,
      identity,
      jwtClaimSnapshot: jwtResult?.ok ? jwtResult.snapshot : null
    };
  }

  return deny(anonymousIdentity, 403, "forbidden", "unsupported_access_mode", null);
}

export function hashApiKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

function extractJwtToken(config: OpenGateConfig, request: RequestEnvelope): string | null {
  const authorization = getHeaderValue(request.headers, "authorization");
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length);
  }

  const cookieName = config.jwt.cookieName ?? "opengate_jwt";
  const cookieValue = request.cookies?.[cookieName];

  return cookieValue ?? null;
}

function extractApiKey(config: OpenGateConfig, request: RequestEnvelope): string | null {
  const headerName = config.apiKeys.headerName.toLowerCase();
  return getHeaderValue(request.headers, headerName) ?? null;
}

async function verifyJwt(config: OpenGateConfig, token: string): Promise<JwtAuthResult> {
  const verification = await getJwtVerifier(config).verify(token);
  if (!verification.ok) {
    return verification;
  }

  const payload = verification.payload;
  const issuerConfig = verification.issuerConfig;
  const secondaryIdentifierClaim = config.identityContext.claim;
  for (const claim of issuerConfig.requiredClaims ?? ["iss", "aud", "exp", "sub", "unique_user_id"]) {
    if (
      claim === secondaryIdentifierClaim &&
      (config.identityContext.required ?? true) === false &&
      (config.behavior?.onMissingSecondaryIdentifier ?? "reject") === "allow"
    ) {
      continue;
    }

    if (payload[claim] === undefined || payload[claim] === null || payload[claim] === "") {
      return {
        ok: false,
        statusCode: 401,
        message: "unauthorized",
        blockReason: `missing_claim:${claim}`
      };
    }
  }

  const subjectClaim = issuerConfig.subjectClaim ?? "sub";
  const organizationClaim = issuerConfig.organizationClaim ?? "org_id";

  const subject = readStringClaim(payload, subjectClaim);
  const organizationId = readStringClaim(payload, organizationClaim);
  const secondaryIdentifier = readStringClaim(payload, secondaryIdentifierClaim);

  if (!subject || !organizationId) {
    return {
      ok: false,
      statusCode: 401,
      message: "unauthorized",
      blockReason: "jwt_identity_incomplete"
    };
  }

  if (!secondaryIdentifier) {
    if ((config.identityContext.required ?? true) && (config.behavior?.onMissingSecondaryIdentifier ?? "reject") === "reject") {
      return {
        ok: false,
        statusCode: 401,
        message: "unauthorized",
        blockReason: "missing_secondary_identifier"
      };
    }
  }

  const organization = config.organizations.find((item) => item.id === organizationId);
  if (!organization) {
    return {
      ok: false,
      statusCode: 403,
      message: "forbidden",
      blockReason: "organization_not_found"
    };
  }

  const user = findUser(config, organizationId, secondaryIdentifier ?? subject);
  if (config.users?.length) {
    if (!user) {
      return {
        ok: false,
        statusCode: 403,
        message: "forbidden",
        blockReason: "user_not_found"
      };
    }

    if (user.enabled === false && (config.behavior?.onDisabledOrganization ?? "block") === "block") {
      return {
        ok: false,
        statusCode: 403,
        message: "forbidden",
        blockReason: "user_disabled"
      };
    }
  }

  if (organization.enabled === false && (config.behavior?.onDisabledOrganization ?? "block") === "block") {
    return {
      ok: false,
      statusCode: 403,
      message: "forbidden",
      blockReason: "organization_disabled"
    };
  }

  return {
    ok: true,
    identity: {
      identityType: "jwt",
      tier: "upgraded",
      organizationId,
      subject,
      secondaryIdentifier: secondaryIdentifier ?? subject,
      scopes: parseScopes(payload.scope),
      rateLimitSubject: `jwt:${
        (config.identityContext.globalUniqueness ?? "global") === "global"
          ? secondaryIdentifier ?? subject
          : `${organizationId}:${secondaryIdentifier ?? subject}`
      }`,
      jwtClaims: payload,
      issuer: issuerConfig.issuer
    },
    snapshot: createJwtSnapshot(config, payload)
  };
}

function verifyApiKey(config: OpenGateConfig, rawApiKey: string): ApiKeyAuthResult {
  const keyHash = hashApiKey(rawApiKey);
  const match = findApiKeyMatch(config.apiKeys.clients, keyHash);
  const client = match?.client;
  const keyVersion = match?.keyVersion;

  if (!client || !keyVersion || client.enabled === false) {
    return {
      ok: false,
      statusCode: 401,
      message: "unauthorized",
      blockReason: "invalid_api_key"
    };
  }

  const organization = config.organizations.find((item) => item.id === client.organizationId);
  if (!organization) {
    return {
      ok: false,
      statusCode: 403,
      message: "forbidden",
      blockReason: "organization_not_found"
    };
  }

  const user = findUser(config, client.organizationId, client.userId);
  if (config.users?.length) {
    if (!user) {
      return {
        ok: false,
        statusCode: 403,
        message: "forbidden",
        blockReason: "user_not_found"
      };
    }

    if (user.enabled === false && (config.behavior?.onDisabledOrganization ?? "block") === "block") {
      return {
        ok: false,
        statusCode: 403,
        message: "forbidden",
        blockReason: "user_disabled"
      };
    }
  }

  if (organization.enabled === false && (config.behavior?.onDisabledOrganization ?? "block") === "block") {
    return {
      ok: false,
      statusCode: 403,
      message: "forbidden",
      blockReason: "organization_disabled"
    };
  }

  return {
    ok: true,
    identity: {
      identityType: "api_key",
      tier: "upgraded",
      organizationId: client.organizationId,
      subject: client.userId,
      secondaryIdentifier: client.userId,
      scopes: client.scopes ?? [],
      rateLimitSubject: `api_key:${client.id}:${keyVersion.id}`,
      apiClientId: client.id,
      apiKeyVersionId: keyVersion.id
    }
  };
}

function readStringClaim(payload: Record<string, unknown>, claimName: string): string | null {
  const value = payload[claimName];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseScopes(scopeClaim: unknown): string[] {
  if (Array.isArray(scopeClaim)) {
    return scopeClaim.filter((item): item is string => typeof item === "string" && item.length > 0);
  }

  if (typeof scopeClaim === "string") {
    return scopeClaim.split(" ").filter(Boolean);
  }

  return [];
}

function createJwtSnapshot(config: OpenGateConfig, claims: Record<string, unknown>) {
  const allowList = config.audit.jwtClaimSnapshot ?? ["iss", "aud", "sub", "org_id", "unique_user_id"];
  const snapshot: Record<string, unknown> = {};

  for (const claim of allowList) {
    if (claims[claim] !== undefined) {
      snapshot[claim] = claims[claim];
    }
  }

  return snapshot;
}

function enforceScopes(policy: ResolvedRoutePolicy, identity: RequestIdentity) {
  if (!policy.requiredScopes.length) {
    return { allowed: true as const };
  }

  const hasScopes = policy.requiredScopes.every((scope) => identity.scopes.includes(scope));
  if (hasScopes) {
    return { allowed: true as const };
  }

  return {
    allowed: false as const,
    statusCode: 403,
    message: "forbidden",
    blockReason: "insufficient_scope"
  };
}

function deny(
  identity: RequestIdentity,
  statusCode: number,
  message: string,
  blockReason: string,
  jwtClaimSnapshot: Record<string, unknown> | null
): AuthorizationDecision {
  return {
    allowed: false,
    identity,
    statusCode,
    message,
    blockReason,
    jwtClaimSnapshot
  };
}

function findUser(config: OpenGateConfig, organizationId: string, userId: string) {
  return config.users?.find((user) => user.organizationId === organizationId && user.id === userId) ?? null;
}

export function createApiClientConfig(input: Omit<ApiClientConfig, "keyHash"> & { rawKey: string }): ApiClientConfig {
  const keyVersion = createApiKeyVersionConfig({
    id: `${input.id}-primary-key`,
    rawKey: input.rawKey,
    createdAt: new Date().toISOString(),
    enabled: true
  });

  return {
    ...input,
    keyVersions: [keyVersion]
  };
}

export function createApiKeyVersionConfig(
  input: Omit<ApiKeyVersionConfig, "keyHash"> & { rawKey: string }
): ApiKeyVersionConfig {
  return {
    ...input,
    keyHash: hashApiKey(input.rawKey)
  };
}

function findApiKeyMatch(clients: ApiClientConfig[], keyHash: string) {
  const now = new Date();

  for (const client of clients) {
    const keyVersions = client.keyVersions ?? [];
    for (const keyVersion of keyVersions) {
      if (keyVersion.keyHash !== keyHash) {
        continue;
      }

      if (!isKeyVersionActive(keyVersion, now)) {
        return null;
      }

      return {
        client,
        keyVersion
      };
    }
  }

  return null;
}

function isKeyVersionActive(keyVersion: ApiKeyVersionConfig, now: Date) {
  if (keyVersion.enabled === false) {
    return false;
  }

  if (keyVersion.notBefore && now < new Date(keyVersion.notBefore)) {
    return false;
  }

  if (keyVersion.expiresAt && now >= new Date(keyVersion.expiresAt)) {
    return false;
  }

  if (keyVersion.revokedAt && now >= new Date(keyVersion.revokedAt)) {
    return false;
  }

  return true;
}
