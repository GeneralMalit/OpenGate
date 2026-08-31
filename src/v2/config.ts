import path from "node:path";
import { z, type ZodIssue } from "zod";

/** Runtime-only configuration for the standalone v2 gateway.
 *
 * Product data (APIs, roles, consumers, and keys) lives in SQLite.  This
 * object intentionally contains only process/deployment settings and secrets.
 */
export type RuntimeConfig = {
  databasePath: string;
  keyPepper: string;
  sessionSecret: string;
  bindHost: string;
  port: number;
  publicBaseUrl: string;
  trustedProxyHops: number;
  environment: "development" | "test" | "production";
  apiKeyHeader: string;
  adminCookieName: string;
  maxBodyBytes: number;
  upstreamConnectTimeoutMs: number;
  upstreamHeadersTimeoutMs: number;
  upstreamResponseTimeoutMs: number;
  upstreamMaxConnections: number;
  enableMetrics: boolean;
};

export type RuntimeConfigInput = Record<string, unknown>;

export type ConfigValidationIssue = { path: string; message: string };

export class RuntimeConfigError extends Error {
  readonly issues: ConfigValidationIssue[];

  constructor(issues: ConfigValidationIssue[]) {
    super(`OpenGate runtime configuration is invalid: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
    this.name = "RuntimeConfigError";
    this.issues = issues;
  }
}

const runtimeSchema = z.object({
  databasePath: z.string().min(1),
  keyPepper: z.string().min(32, "must be at least 32 characters"),
  sessionSecret: z.string().min(32, "must be at least 32 characters"),
  bindHost: z.string().min(1),
  port: z.number().int().min(1).max(65_535),
  publicBaseUrl: z.string().url(),
  trustedProxyHops: z.number().int().min(0),
  environment: z.enum(["development", "test", "production"]),
  apiKeyHeader: z.string().regex(/^[A-Za-z][A-Za-z0-9-]*$/, "must be a valid HTTP header name"),
  adminCookieName: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/, "must be a valid cookie name"),
  maxBodyBytes: z.number().int().positive(),
  upstreamConnectTimeoutMs: z.number().int().positive(),
  upstreamHeadersTimeoutMs: z.number().int().positive(),
  upstreamResponseTimeoutMs: z.number().int().positive(),
  upstreamMaxConnections: z.number().int().positive(),
  enableMetrics: z.boolean()
}).superRefine((config, context) => {
  let url: URL;
  try {
    url = new URL(config.publicBaseUrl);
  } catch {
    return;
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["publicBaseUrl"], message: "must use http or https" });
  }
  if (config.environment === "production" && url.protocol !== "https:") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["publicBaseUrl"], message: "production publicBaseUrl must use HTTPS" });
  }
  if (config.environment === "production" && config.bindHost === "0.0.0.0" && url.hostname === "localhost") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["publicBaseUrl"], message: "publicBaseUrl must identify the real public host" });
  }
});

const DEFAULTS = {
  bindHost: "127.0.0.1",
  trustedProxyHops: 0,
  apiKeyHeader: "X-OpenGate-Key",
  adminCookieName: "opengate_session",
  maxBodyBytes: 10 * 1024 * 1024,
  upstreamConnectTimeoutMs: 5_000,
  upstreamHeadersTimeoutMs: 15_000,
  upstreamResponseTimeoutMs: 60_000,
  upstreamMaxConnections: 100,
  enableMetrics: true
} as const;

/** Parse and validate already-normalized runtime values. */
export function validateRuntimeConfig(input: RuntimeConfigInput): RuntimeConfig {
  const port = coerceInteger(input.port, 8080);
  const environment = normalizeEnvironment(input.environment);
  const databasePath = normalizeDatabaseUrl(input.databasePath ?? "./data/opengate.sqlite");
  const publicBaseUrl = String(input.publicBaseUrl ?? `http://${DEFAULTS.bindHost}:${port}`);

  const result = runtimeSchema.safeParse({
    databasePath,
    keyPepper: input.keyPepper,
    sessionSecret: input.sessionSecret,
    bindHost: String(input.bindHost ?? DEFAULTS.bindHost),
    port,
    publicBaseUrl,
    trustedProxyHops: coerceInteger(input.trustedProxyHops, DEFAULTS.trustedProxyHops),
    environment,
    apiKeyHeader: String(input.apiKeyHeader ?? DEFAULTS.apiKeyHeader),
    adminCookieName: String(input.adminCookieName ?? DEFAULTS.adminCookieName),
    maxBodyBytes: coerceInteger(input.maxBodyBytes, DEFAULTS.maxBodyBytes),
    upstreamConnectTimeoutMs: coerceInteger(input.upstreamConnectTimeoutMs, DEFAULTS.upstreamConnectTimeoutMs),
    upstreamHeadersTimeoutMs: coerceInteger(input.upstreamHeadersTimeoutMs, DEFAULTS.upstreamHeadersTimeoutMs),
    upstreamResponseTimeoutMs: coerceInteger(input.upstreamResponseTimeoutMs, DEFAULTS.upstreamResponseTimeoutMs),
    upstreamMaxConnections: coerceInteger(input.upstreamMaxConnections, DEFAULTS.upstreamMaxConnections),
    enableMetrics: coerceBoolean(input.enableMetrics, DEFAULTS.enableMetrics)
  });

  if (!result.success) {
    throw new RuntimeConfigError(result.error.issues.map(formatIssue));
  }

  return result.data;
}

/** Read OPENGATE_* environment variables and validate them. */
export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  return validateRuntimeConfig({
    databasePath: env.OPENGATE_DATABASE_URL,
    keyPepper: env.OPENGATE_KEY_PEPPER,
    sessionSecret: env.OPENGATE_SESSION_SECRET,
    bindHost: env.OPENGATE_BIND_HOST,
    port: env.OPENGATE_PORT,
    publicBaseUrl: env.OPENGATE_PUBLIC_BASE_URL,
    trustedProxyHops: env.OPENGATE_TRUSTED_PROXY_HOPS,
    environment: env.NODE_ENV,
    apiKeyHeader: env.OPENGATE_API_KEY_HEADER,
    adminCookieName: env.OPENGATE_ADMIN_COOKIE_NAME,
    maxBodyBytes: env.OPENGATE_MAX_BODY_BYTES,
    upstreamConnectTimeoutMs: env.OPENGATE_UPSTREAM_CONNECT_TIMEOUT_MS,
    upstreamHeadersTimeoutMs: env.OPENGATE_UPSTREAM_HEADERS_TIMEOUT_MS,
    upstreamResponseTimeoutMs: env.OPENGATE_UPSTREAM_RESPONSE_TIMEOUT_MS,
    upstreamMaxConnections: env.OPENGATE_UPSTREAM_MAX_CONNECTIONS,
    enableMetrics: env.OPENGATE_ENABLE_METRICS
  });
}

export function formatRuntimeConfigIssues(error: unknown): string {
  if (error instanceof RuntimeConfigError) return error.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n");
  return error instanceof Error ? error.message : String(error);
}

function normalizeDatabaseUrl(value: unknown): string {
  const candidate = String(value ?? "./data/opengate.sqlite");
  if (candidate === ":memory:") return candidate;
  if (candidate.startsWith("file:")) return candidate.slice("file:".length);
  if (/^[a-z][a-z0-9+.-]*:/i.test(candidate) && !/^[A-Za-z]:[\\/]/.test(candidate)) {
    throw new RuntimeConfigError([{ path: "databasePath", message: "must be a SQLite path or :memory:" }]);
  }
  return path.normalize(candidate);
}

function coerceInteger(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  return typeof value === "number" ? value : Number(value);
}

function coerceBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (String(value).toLowerCase() === "true") return true;
  if (String(value).toLowerCase() === "false") return false;
  return Boolean(value);
}

function normalizeEnvironment(value: unknown): RuntimeConfig["environment"] {
  if (value === "production" || value === "test") return value;
  return "development";
}

function formatIssue(issue: ZodIssue): ConfigValidationIssue {
  return { path: issue.path.length ? issue.path.join(".") : "config", message: issue.message };
}
