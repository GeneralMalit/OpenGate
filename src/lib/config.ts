import fs from "node:fs";
import path from "node:path";
import { z, type ZodIssue } from "zod";
import type { ApiClientConfig, JwtIssuerConfig, OpenGateConfig, UserConfig } from "./types.js";

const DEFAULT_CONFIG_PATH = "opengate.config.json";
const DEFAULT_REQUIRED_CLAIMS = ["iss", "aud", "exp", "sub", "unique_user_id"];
const DEFAULT_OPTIONAL_CLAIMS = ["scope"];
const DEFAULT_AUDIT_CLAIMS = ["iss", "aud", "sub", "org_id", "unique_user_id"];
const LEGACY_KEY_CREATED_AT = "1970-01-01T00:00:00.000Z";
const ALLOWED_JWKS_ALGORITHMS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"] as const;

const organizationSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean().default(true)
});

const userSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  organizationId: z.string().min(1),
  email: z.string().email().optional(),
  enabled: z.boolean().default(true)
});

const jwtIssuerSchema = z.object({
  issuer: z.string().min(1),
  audiences: z.array(z.string().min(1)).min(1),
  enabled: z.boolean().default(true),
  verificationMode: z.enum(["shared_secret", "jwks"]).default("shared_secret"),
  sharedSecret: z.string().min(1).optional(),
  jwksUrl: z.string().url().optional(),
  allowedAlgorithms: z.array(z.enum(ALLOWED_JWKS_ALGORITHMS)).min(1).optional(),
  cacheTtlMs: z.number().int().positive().optional(),
  requestTimeoutMs: z.number().int().positive().optional(),
  organizationClaim: z.string().min(1).default("org_id"),
  subjectClaim: z.string().min(1).default("sub"),
  requiredClaims: z.array(z.string().min(1)).default(DEFAULT_REQUIRED_CLAIMS),
  optionalClaims: z.array(z.string().min(1)).default(DEFAULT_OPTIONAL_CLAIMS)
}).superRefine((issuer, ctx) => {
  if (issuer.verificationMode === "shared_secret" && !issuer.sharedSecret) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sharedSecret"],
      message: "Shared-secret issuers must define sharedSecret."
    });
  }

  if (issuer.verificationMode === "jwks") {
    if (!issuer.jwksUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["jwksUrl"],
        message: "JWKS issuers must define jwksUrl."
      });
    }

    if (!issuer.allowedAlgorithms?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowedAlgorithms"],
        message: "JWKS issuers must define at least one allowed algorithm."
      });
    }
  }
});

const apiKeyVersionSchema = z.object({
  id: z.string().min(1),
  keyHash: z.string().min(1),
  createdAt: z.string().datetime(),
  notBefore: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
  revokedAt: z.string().datetime().optional(),
  enabled: z.boolean().default(true)
});

const apiClientSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  organizationId: z.string().min(1),
  userId: z.string().min(1),
  keyHash: z.string().min(1).optional(),
  keyVersions: z.array(apiKeyVersionSchema).min(1).optional(),
  scopes: z.array(z.string().min(1)).default([]),
  enabled: z.boolean().default(true)
}).superRefine((client, ctx) => {
  if (!client.keyHash && !client.keyVersions?.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "API clients must define either keyHash or keyVersions."
    });
  }

  if (client.keyHash && client.keyVersions?.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "API clients must not define both keyHash and keyVersions."
    });
  }
});

const routePolicySchema = z.object({
  id: z.string().min(1),
  pathPrefix: z.string().min(1),
  accessMode: z.enum(["public", "authenticated", "jwt", "api_key"]),
  requiredScopes: z.array(z.string().min(1)).default([]),
  enabled: z.boolean().default(true)
});

const rateLimitTierSchema = z.object({
  points: z.number().int().positive(),
  duration: z.literal("calendar_day").default("calendar_day")
});

const configSchema = z.object({
  organizations: z.array(organizationSchema).default([]),
  users: z.array(userSchema).default([]),
  jwt: z.object({
    cookieName: z.string().min(1).default("opengate_jwt"),
    issuers: z.array(jwtIssuerSchema).min(1)
  }),
  apiKeys: z.object({
    headerName: z.string().min(1).default("x-api-key"),
    clients: z.array(apiClientSchema).default([])
  }),
  identityContext: z.object({
    source: z.literal("jwt_claim").default("jwt_claim"),
    claim: z.string().min(1).default("unique_user_id"),
    required: z.boolean().default(true),
    globalUniqueness: z.enum(["global", "organization"]).default("global")
  }).default({}),
  routePolicies: z.array(routePolicySchema).min(1),
  rateLimits: z.object({
    timezone: z.string().min(1).default("UTC"),
    store: z.enum(["memory", "redis"]).default("memory"),
    redisUrl: z.string().url().optional(),
    redisKeyPrefix: z.string().min(1).default("opengate:rate-limit"),
    redisKeyExpirySeconds: z.number().int().positive().optional(),
    free: rateLimitTierSchema,
    upgraded: rateLimitTierSchema
  }),
  audit: z.object({
    enabled: z.boolean().default(true),
    backend: z.enum(["sqlite", "postgres"]).default("sqlite"),
    sqlitePath: z.string().min(1),
    postgresUrl: z.string().url().optional(),
    postgresTable: z.string().min(1).default("audit_events"),
    flushIntervalMs: z.number().int().positive().default(25),
    maxQueueSize: z.number().int().positive().default(1000),
    batchSize: z.number().int().positive().default(50),
    jwtClaimSnapshot: z.array(z.string().min(1)).default(DEFAULT_AUDIT_CLAIMS)
  }),
  observability: z.object({
    requestIdHeader: z.string().min(1).default("x-request-id"),
    healthPath: z.string().min(1).default("/healthz"),
    readyPath: z.string().min(1).default("/readyz"),
    metricsPath: z.string().min(1).default("/metrics"),
    statusPath: z.string().min(1).default("/status")
  }).default({}),
  behavior: z.object({
    onMissingSecondaryIdentifier: z.enum(["reject", "allow"]).default("reject"),
    onCredentialMismatch: z.enum(["deny", "prefer_jwt"]).default("deny"),
    onDisabledOrganization: z.enum(["block", "allow"]).default("block")
  }).default({})
});

type ParsedJwtIssuer = z.infer<typeof jwtIssuerSchema>;
type ParsedApiClient = z.infer<typeof apiClientSchema>;

export type ConfigSource = OpenGateConfig | string | undefined;
export type ConfigValidationIssue = {
  path: string;
  message: string;
};

export type ConfigValidationSuccess = {
  ok: true;
  config: OpenGateConfig;
  warnings: string[];
};

export type ConfigValidationFailure = {
  ok: false;
  issues: ConfigValidationIssue[];
};

export type ConfigValidationReport = ConfigValidationSuccess | ConfigValidationFailure;

export class ConfigValidationError extends Error {
  readonly issues: ConfigValidationIssue[];

  constructor(issues: ConfigValidationIssue[]) {
    super(formatValidationErrorMessage(issues));
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

export function validateConfig(raw: unknown, baseDir = process.cwd()): OpenGateConfig {
  const report = validateConfigDetailed(raw, baseDir);

  if (!report.ok) {
    throw new ConfigValidationError(report.issues);
  }

  return report.config;
}

export function loadConfig(source?: ConfigSource): OpenGateConfig {
  if (!source) {
    return loadConfigFromPath(DEFAULT_CONFIG_PATH);
  }

  if (typeof source === "string") {
    return loadConfigFromPath(source);
  }

  return validateConfig(source);
}

export function validateConfigDetailed(raw: unknown, baseDir = process.cwd()): ConfigValidationReport {
  const parsedResult = configSchema.safeParse(raw);
  if (!parsedResult.success) {
    return {
      ok: false,
      issues: parsedResult.error.issues.map(formatIssue)
    };
  }

  const parsed = parsedResult.data;
  const normalizedJwtIssuers = parsed.jwt.issuers.map((issuer) => normalizeJwtIssuer(issuer));
  const normalizedApiClients = parsed.apiKeys.clients.map((client) => normalizeApiClient(client));
  const normalizedUsers = parsed.users.map((user) => normalizeUser(user, parsed.organizations));
  const auditIssue = validateAuditClaimAllowList(parsed.audit.jwtClaimSnapshot, normalizedJwtIssuers, parsed.identityContext.claim);
  if (auditIssue) {
    return {
      ok: false,
      issues: [auditIssue]
    };
  }

  const storageIssue = validateStorageBackends(parsed);
  if (storageIssue) {
    return {
      ok: false,
      issues: [storageIssue]
    };
  }

  return {
    ok: true,
    warnings: collectMigrationWarnings(raw),
    config: {
      ...parsed,
      jwt: {
        ...parsed.jwt,
        issuers: normalizedJwtIssuers
      },
      apiKeys: {
        ...parsed.apiKeys,
        clients: normalizedApiClients
      },
      users: normalizedUsers,
      audit: {
        ...parsed.audit,
        sqlitePath: resolveSqlitePath(parsed.audit.sqlitePath, baseDir)
      }
    }
  };
}

export function migrateConfig(raw: unknown, baseDir = process.cwd()): ConfigValidationSuccess {
  const report = validateConfigDetailed(raw, baseDir);
  if (!report.ok) {
    throw new ConfigValidationError(report.issues);
  }

  return report;
}

function loadConfigFromPath(configPath: string): OpenGateConfig {
  const absolutePath = path.isAbsolute(configPath)
    ? configPath
    : path.join(process.cwd(), configPath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Config file not found: ${absolutePath}`);
  }

  const raw = JSON.parse(fs.readFileSync(absolutePath, "utf8")) as unknown;
  return validateConfig(raw, path.dirname(absolutePath));
}

function resolveSqlitePath(sqlitePath: string, baseDir: string): string {
  if (sqlitePath === ":memory:" || path.isAbsolute(sqlitePath)) {
    return sqlitePath;
  }

  return path.join(baseDir, sqlitePath);
}

function normalizeJwtIssuer(issuer: ParsedJwtIssuer): JwtIssuerConfig {
  if (issuer.verificationMode === "jwks") {
    const jwksUrl = issuer.jwksUrl;
    const allowedAlgorithms = issuer.allowedAlgorithms;

    if (!jwksUrl || !allowedAlgorithms?.length) {
      throw new Error(`Invalid JWKS issuer config for ${issuer.issuer}.`);
    }

    return {
      ...issuer,
      verificationMode: "jwks",
      jwksUrl,
      allowedAlgorithms,
      cacheTtlMs: issuer.cacheTtlMs ?? 300_000,
      requestTimeoutMs: issuer.requestTimeoutMs ?? 5_000
    };
  }

  const sharedSecret = issuer.sharedSecret;
  if (!sharedSecret) {
    throw new Error(`Invalid shared-secret issuer config for ${issuer.issuer}.`);
  }

  return {
    ...issuer,
    verificationMode: "shared_secret",
    sharedSecret
  };
}

function normalizeApiClient(client: ParsedApiClient): ApiClientConfig {
  if (client.keyVersions?.length) {
    return {
      ...client,
      keyHash: undefined
    };
  }

  return {
    ...client,
    keyHash: undefined,
    keyVersions: [
      {
        id: `${client.id}-legacy-key`,
        keyHash: client.keyHash ?? "",
        createdAt: LEGACY_KEY_CREATED_AT,
        enabled: true
      }
    ]
  };
}

function normalizeUser(user: UserConfig, organizations: z.infer<typeof organizationSchema>[]): UserConfig {
  if (!organizations.some((organization) => organization.id === user.organizationId)) {
    throw new Error(`Invalid user config for ${user.id}: unknown organization "${user.organizationId}".`);
  }

  return {
    ...user,
    enabled: user.enabled ?? true
  };
}

function collectMigrationWarnings(raw: unknown) {
  const warnings: string[] = [];

  if (!raw || typeof raw !== "object") {
    return warnings;
  }

  const root = raw as Record<string, unknown>;
  const jwtSection = root.jwt && typeof root.jwt === "object" ? (root.jwt as Record<string, unknown>) : null;
  const apiKeysSection = root.apiKeys && typeof root.apiKeys === "object" ? (root.apiKeys as Record<string, unknown>) : null;

  const rawJwtIssuers = Array.isArray(jwtSection?.issuers) ? jwtSection.issuers : [];
  const rawApiClients = Array.isArray(apiKeysSection?.clients) ? apiKeysSection.clients : [];

  rawJwtIssuers.forEach((issuer, index) => {
    if (issuer && typeof issuer === "object" && !("verificationMode" in issuer)) {
      warnings.push(`jwt.issuers[${index}] defaulted to verificationMode="shared_secret".`);
    }
  });

  rawApiClients.forEach((client, index) => {
    if (client && typeof client === "object" && "keyHash" in client && !("keyVersions" in client)) {
      warnings.push(`apiKeys.clients[${index}] migrated from keyHash to keyVersions[0].`);
    }
  });

  return warnings;
}

function formatIssue(issue: ZodIssue): ConfigValidationIssue {
  return {
    path: issue.path.length ? issue.path.join(".") : "config",
    message: issue.message
  };
}

function formatValidationErrorMessage(issues: ConfigValidationIssue[]) {
  if (!issues.length) {
    return "OpenGate config validation failed.";
  }

  const [firstIssue] = issues;
  return `OpenGate config validation failed: ${firstIssue?.path ?? "config"}: ${firstIssue?.message ?? "Unknown error."}`;
}

function validateAuditClaimAllowList(
  configuredClaims: string[],
  jwtIssuers: JwtIssuerConfig[],
  identityClaim: string
): ConfigValidationIssue | null {
  const supportedClaims = new Set<string>(DEFAULT_AUDIT_CLAIMS);
  supportedClaims.add(identityClaim);

  for (const issuer of jwtIssuers) {
    supportedClaims.add(issuer.subjectClaim ?? "sub");
    supportedClaims.add(issuer.organizationClaim ?? "org_id");

    for (const claim of issuer.requiredClaims ?? DEFAULT_REQUIRED_CLAIMS) {
      supportedClaims.add(claim);
    }

    for (const claim of issuer.optionalClaims ?? DEFAULT_OPTIONAL_CLAIMS) {
      supportedClaims.add(claim);
    }
  }

  for (const claim of configuredClaims) {
    if (!supportedClaims.has(claim)) {
      return {
        path: "audit.jwtClaimSnapshot",
        message: `Unsupported claim "${claim}". Allowed claims must come from the approved identity and issuer claim set.`
      };
    }
  }

  return null;
}

function validateStorageBackends(config: z.infer<typeof configSchema>): ConfigValidationIssue | null {
  if (config.rateLimits.store === "redis" && !config.rateLimits.redisUrl) {
    return {
      path: "rateLimits.redisUrl",
      message: "Redis rate-limit store requires rateLimits.redisUrl."
    };
  }

  if (config.audit.backend === "postgres" && !config.audit.postgresUrl) {
    return {
      path: "audit.postgresUrl",
      message: "Postgres audit backend requires audit.postgresUrl."
    };
  }

  return null;
}
