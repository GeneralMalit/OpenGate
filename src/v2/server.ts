import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { registerAdminRoutes } from "./admin/index.js";
import { setupPageResponse } from "./admin/ui.js";
import { loadRuntimeConfig, type RuntimeConfig } from "./config.js";
import { closeDatabase, openDatabase, type SqliteDatabase, SqliteAdminStore, withTransaction } from "./data/index.js";
import {
  decideLimits,
  getCalendarBucket,
  isPermitted,
  parseApiKey,
  verifyApiKey
} from "./domain/index.js";
import { checkReadiness, createMetrics, createStructuredLogger, registerHealthRoutes } from "./observability/index.js";
import { buildUpstreamUrl, mapProxyError, proxyRequest, streamProxyResponse } from "./proxy/index.js";

export type OpenGateV2App = {
  app: FastifyInstance;
  db: SqliteDatabase;
  store: SqliteAdminStore;
  config: RuntimeConfig;
  close: () => Promise<void>;
};

export type CreateV2AppOptions = {
  config?: RuntimeConfig;
  db?: SqliteDatabase;
};

type GatewayRequestParams = { slug: string; "*"?: string };
type GatewayRecord = {
  id: string;
  slug: string;
  enabled: number;
};

export async function createOpenGateV2(options: CreateV2AppOptions = {}): Promise<OpenGateV2App> {
  const config = options.config ?? loadRuntimeConfig();
  const db = options.db ?? openDatabase(config.databasePath);
  const ownsDatabase = !options.db;
  const store = new SqliteAdminStore(db);
  const metrics = createMetrics();
  const logger = createStructuredLogger();
  const startedAt = Date.now();
  const app = Fastify({
    logger: false,
    bodyLimit: config.maxBodyBytes,
    trustProxy: config.trustedProxyHops
  });

  await app.register(cookie);

  app.addHook("onSend", async (request, reply) => {
    if (request.url.startsWith("/admin")) {
      reply.header("cache-control", "no-store");
      reply.header("x-content-type-options", "nosniff");
      reply.header("x-frame-options", "DENY");
      reply.header("referrer-policy", "no-referrer");
    }
  });

  // Admin requests are JSON. The proxy accepts all other payloads as buffers
  // so it can preserve their exact bytes when forwarding them upstream.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    if (request.url.startsWith("/apis/")) {
      done(null, Buffer.from(body));
      return;
    }
    try { done(null, body.length ? JSON.parse(body.toString()) : {}); }
    catch { done(new Error("invalid JSON")); }
  });
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => done(null, body));

  registerHealthRoutes(app, {
    db,
    startedAt,
    metrics: config.enableMetrics ? () => metrics.toJSON() : undefined
  });

  await registerAdminRoutes(app, {
    store,
    keyPepper: config.keyPepper,
    sessionSecret: config.sessionSecret,
    secureCookies: config.environment === "production",
    upstreamValidationOptions: { production: config.environment === "production", allowPrivateNetworks: config.environment !== "production" },
    passwordHasher: undefined
  });

  app.get("/admin", async (_request, reply) => {
    const nonce = randomBytes(16).toString("base64url");
    const page = setupPageResponse({ nonce });
    for (const [name, value] of Object.entries(page.headers)) reply.header(name, value);
    return reply.type("text/html; charset=utf-8").send(page.body);
  });

  const proxyHandler = async (request: FastifyRequest<{ Params: GatewayRequestParams }>, reply: import("fastify").FastifyReply) => {
    const started = process.hrtime.bigint();
    const requestId = resolveRequestId(request);
    const method = request.method.toUpperCase();
    const slug = request.params.slug;
    const suffix = `/${request.params["*"] ?? ""}`.replace(/\/{2,}/g, "/");
    const path = suffix === "/" && request.url.includes(`/${slug}/`) ? "/" : suffix;
    const audit = (input: { statusCode: number; outcome: "allowed" | "blocked"; reason: string | null; apiId?: string | null; consumerId?: string | null; roleId?: string | null; keyId?: string | null; upstreamStatus?: number | null }) => {
      try {
        db.prepare("INSERT INTO audit_events(occurred_at,request_id,api_id,consumer_id,role_id,key_id,method,path,status_code,outcome,reason,latency_ms,upstream_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(new Date().toISOString(), requestId, input.apiId ?? null, input.consumerId ?? null, input.roleId ?? null, input.keyId ?? null, method, path, input.statusCode, input.outcome, input.reason, Math.max(0, Math.round(Number(process.hrtime.bigint() - started) / 1_000_000)), input.upstreamStatus ?? null);
      } catch (error) {
        logger.emit({ level: "error", event: "audit.write.failed", requestId, error: error instanceof Error ? error.message : "unknown" });
      }
    };
    const deny = (statusCode: number, error: string, reason: string, context: { apiId?: string; consumerId?: string; roleId?: string; keyId?: string } = {}) => {
      metrics.increment("deniedTotal");
      if (statusCode === 429) metrics.increment("rateLimitedTotal");
      audit({ statusCode, outcome: "blocked", reason, ...context });
      return reply.code(statusCode).send({ error });
    };

    metrics.increment("requestsTotal");
    const api = db.prepare("SELECT id,slug,enabled FROM apis WHERE slug = ?").get(slug) as GatewayRecord | undefined;
    if (!api || api.enabled !== 1) return deny(404, "not found", "api_not_found");

    const header = request.headers[config.apiKeyHeader.toLowerCase()];
    if (Array.isArray(header) || typeof header !== "string") return deny(401, "unauthorized", "key_missing", { apiId: api.id });
    const parsed = parseApiKey(header);
    if (!parsed) return deny(401, "unauthorized", "key_invalid", { apiId: api.id });
    const context = store.findGatewayContext(parsed.keyId, api.id);
    if (!context || !verifyApiKey(header, context.key, config.keyPepper, { consumerEnabled: context.consumerEnabled })) {
      return deny(401, "unauthorized", "key_invalid", { apiId: api.id });
    }
    if (!context.assignment || !context.assignment.enabled || !context.role || !context.role.enabled) {
      return deny(403, "forbidden", "assignment_missing", { apiId: api.id, consumerId: context.key.consumerId, keyId: context.key.keyId });
    }
    if (!isPermitted(context.permissions, api.id, method, path)) {
      return deny(403, "forbidden", "permission_denied", { apiId: api.id, consumerId: context.key.consumerId, roleId: context.role.id, keyId: context.key.keyId });
    }

    const limitResult = withTransaction(db, () => consumeLimits(store, context.assignment!.assignmentId, context.role!, Date.now()), true);
    if (!limitResult.allowed) {
      if (limitResult.retryAfterSeconds) reply.header("retry-after", String(limitResult.retryAfterSeconds));
      reply.header("x-ratelimit-limit", String(context.role.rateLimitCount ?? context.role.quotaCount ?? 0));
      reply.header("x-ratelimit-remaining", "0");
      return deny(429, "rate limited", limitResult.reasons.join("_"), { apiId: api.id, consumerId: context.key.consumerId, roleId: context.role.id, keyId: context.key.keyId });
    }

    const upstream = buildUpstreamUrl(context.api.upstreamBaseUrl, path, { query: request.url.includes("?") ? request.url.slice(request.url.indexOf("?") + 1) : undefined, validation: { production: config.environment === "production", allowPrivateNetworks: config.environment !== "production" } });
    try {
      const body = proxyBody(request);
      const proxied = await proxyRequest({
        url: upstream,
        method,
        headers: request.headers,
        body,
        maxRequestBytes: config.maxBodyBytes,
        maxResponseBytes: config.maxBodyBytes,
        connectTimeoutMs: config.upstreamConnectTimeoutMs,
        headersTimeoutMs: config.upstreamHeadersTimeoutMs,
        responseTimeoutMs: config.upstreamResponseTimeoutMs,
        credentialHeader: config.apiKeyHeader
      });
      store.touchApiKey(context.key.keyId);
      metrics.increment("allowedTotal");
      audit({ statusCode: proxied.statusCode, outcome: "allowed", reason: null, apiId: api.id, consumerId: context.key.consumerId, roleId: context.role.id, keyId: context.key.keyId, upstreamStatus: proxied.statusCode });
      reply.hijack();
      reply.raw.statusCode = proxied.statusCode;
      await streamProxyResponse(proxied, reply.raw);
      return;
    } catch (error) {
      metrics.increment("proxyErrorsTotal");
      const mapped = mapProxyError(error);
      audit({ statusCode: mapped.statusCode, outcome: "blocked", reason: "upstream_error", apiId: api.id, consumerId: context.key.consumerId, roleId: context.role.id, keyId: context.key.keyId });
      return reply.code(mapped.statusCode).send(mapped.body);
    }
  };

  app.route({ method: ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"], url: "/apis/:slug", handler: proxyHandler });
  app.route({ method: ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"], url: "/apis/:slug/*", handler: proxyHandler });

  app.addHook("onClose", async () => {
    if (ownsDatabase) closeDatabase(db);
  });

  return { app, db, store, config, close: () => app.close() };
}

function consumeLimits(store: SqliteAdminStore, assignmentId: number, role: { rateLimitCount?: number | null; rateLimitWindowSeconds?: number | null; quotaCount?: number | null; quotaPeriod?: "day" | "month" | null }, nowMs: number) {
  const rateState = store.getLimitBucket(assignmentId, "rate", "current");
  const quotaPeriod = role.quotaPeriod ?? undefined;
  const calendar = quotaPeriod ? getCalendarBucket(nowMs, quotaPeriod) : undefined;
  const quotaState = calendar ? store.getLimitBucket(assignmentId, "quota", calendar.key) : null;
  const decision = decideLimits({
    limits: role,
    rate: rateState ? { tokens: rateState.tokensOrCount, updatedAtMs: Date.parse(rateState.updatedAt) } : null,
    quota: quotaState ? { count: quotaState.tokensOrCount, bucketKey: quotaState.bucketKey } : null,
    quotaBucketKey: calendar?.key,
    quotaResetAtMs: calendar?.resetAtMs,
    nowMs
  });
  if (!decision.allowed) return decision;
  const now = new Date(nowMs).toISOString();
  if (decision.rate) store.upsertLimitBucket({ assignmentId, kind: "rate", bucketKey: "current", tokensOrCount: decision.rate.state.tokens, updatedAt: now, expiresAt: new Date(nowMs + (role.rateLimitWindowSeconds ?? 0) * 1000).toISOString() });
  if (decision.quota && calendar) store.upsertLimitBucket({ assignmentId, kind: "quota", bucketKey: calendar.key, tokensOrCount: decision.quota.state.count, updatedAt: now, expiresAt: new Date(calendar.resetAtMs).toISOString() });
  return decision;
}

function proxyBody(request: FastifyRequest): Readable | Buffer | string | null {
  if (["GET", "HEAD"].includes(request.method.toUpperCase())) return null;
  const value = request.body;
  if (Buffer.isBuffer(value) || typeof value === "string") return value;
  if (value && typeof (value as Readable).pipe === "function") return value as Readable;
  if (value && typeof value === "object") return Buffer.from(JSON.stringify(value));
  return null;
}

function resolveRequestId(request: FastifyRequest): string {
  const candidate = request.headers["x-request-id"];
  if (typeof candidate === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(candidate)) return candidate;
  return randomUUID();
}

export async function startOpenGateV2(config?: RuntimeConfig): Promise<OpenGateV2App> {
  const runtime = await createOpenGateV2({ config });
  await runtime.app.listen({ host: runtime.config.bindHost, port: runtime.config.port });
  checkReadiness({ db: runtime.db });
  return runtime;
}
