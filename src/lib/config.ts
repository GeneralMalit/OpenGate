import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { OpenGateConfig } from "./types.js";

const DEFAULT_CONFIG_PATH = "opengate.config.json";
const DEFAULT_REQUIRED_CLAIMS = ["iss", "aud", "exp", "sub", "unique_user_id"];
const DEFAULT_OPTIONAL_CLAIMS = ["scope"];
const DEFAULT_AUDIT_CLAIMS = ["iss", "aud", "sub", "org_id", "unique_user_id"];

const organizationSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean().default(true)
});

const jwtIssuerSchema = z.object({
  issuer: z.string().min(1),
  audiences: z.array(z.string().min(1)).min(1),
  sharedSecret: z.string().min(1),
  organizationClaim: z.string().min(1).default("org_id"),
  subjectClaim: z.string().min(1).default("sub"),
  requiredClaims: z.array(z.string().min(1)).default(DEFAULT_REQUIRED_CLAIMS),
  optionalClaims: z.array(z.string().min(1)).default(DEFAULT_OPTIONAL_CLAIMS)
});

const apiClientSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  organizationId: z.string().min(1),
  userId: z.string().min(1),
  keyHash: z.string().min(1),
  scopes: z.array(z.string().min(1)).default([]),
  enabled: z.boolean().default(true)
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
    store: z.string().min(1).default("memory"),
    free: rateLimitTierSchema,
    upgraded: rateLimitTierSchema
  }),
  audit: z.object({
    enabled: z.boolean().default(true),
    sqlitePath: z.string().min(1),
    jwtClaimSnapshot: z.array(z.string().min(1)).default(DEFAULT_AUDIT_CLAIMS)
  }),
  behavior: z.object({
    onMissingSecondaryIdentifier: z.enum(["reject", "allow"]).default("reject"),
    onCredentialMismatch: z.enum(["deny", "prefer_jwt"]).default("deny"),
    onDisabledOrganization: z.enum(["block", "allow"]).default("block")
  }).default({})
});

export type ConfigSource = OpenGateConfig | string | undefined;

export function validateConfig(raw: unknown, baseDir = process.cwd()): OpenGateConfig {
  const parsed = configSchema.parse(raw);

  return {
    ...parsed,
    audit: {
      ...parsed.audit,
      sqlitePath: resolveSqlitePath(parsed.audit.sqlitePath, baseDir)
    }
  };
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
