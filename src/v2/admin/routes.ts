import { createHmac, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  AdminRecord,
  AdminRouteOptions,
  AdminSessionRecord,
  AdminStore,
  ApiRecord,
  ConsumerApiRoleRecord,
  RolePermissionRecord,
} from "./types.js";
import { defaultPasswordHasher, issueApiKey, normalizeMethod, validatePathPattern } from "../domain/index.js";
import { validateUpstreamUrl } from "../proxy/upstream.js";

const DEFAULT_SESSION_COOKIE = "opengate_admin_session";
const DEFAULT_CSRF_COOKIE = "opengate_admin_csrf";
const DEFAULT_SESSION_TTL = 60 * 60 * 8;
const DEFAULT_PEPPER = "opengate-development-key-pepper-change-me";

class ConflictError extends Error {}

const DefaultPasswordHasher = defaultPasswordHasher;

function nowIso(now: () => Date): string { return now().toISOString(); }
function bodyOf(request: FastifyRequest): Record<string, unknown> {
  return (request.body && typeof request.body === "object" ? request.body : {}) as Record<string, unknown>;
}
function stringValue(value: unknown, field = "value", required = true): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error(`${field} is required`);
    return undefined;
  }
  if (typeof value !== "string" || value.length > 2000) throw new Error(`${field} must be a string`);
  return value;
}
function boolValue(value: unknown, fallback = true): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error("enabled must be boolean");
  return value;
}
function positiveInt(value: unknown, field: string, nullable = true): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null && nullable) return null;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${field} must be a positive integer`);
  return value as number;
}
function publicAdmin(admin: AdminRecord): Omit<AdminRecord, "passwordHash"> {
  const { passwordHash: _passwordHash, ...safe } = admin; return safe;
}
function safeError(reply: FastifyReply, status: number, error: string): FastifyReply {
  return reply.code(status).send({ error });
}
function parseCookies(request: FastifyRequest): Record<string, string> {
  const fromPlugin = (request as FastifyRequest & { cookies?: Record<string, string> }).cookies;
  if (fromPlugin) return fromPlugin;
  const raw = String(request.headers.cookie ?? "");
  return Object.fromEntries(raw.split(";").map((part) => part.trim().split("=")).filter((parts) => parts.length >= 2).map(([k, ...v]) => [k, decodeURIComponent(v.join("="))]));
}
function appendCookie(reply: FastifyReply, name: string, value: string, attrs: string): void {
  const line = `${name}=${encodeURIComponent(value)}; ${attrs}`;
  const previous = (reply as FastifyReply & { getHeader?: (name: string) => unknown }).getHeader?.("set-cookie");
  if (!previous) reply.header("set-cookie", line);
  else reply.header("set-cookie", Array.isArray(previous) ? [...previous.map(String), line] : [String(previous), line]);
}
function setCookie(reply: FastifyReply, name: string, value: string, opts: { httpOnly: boolean; secure: boolean; maxAge?: number; path?: string }): void {
  const attrs = [`Path=${opts.path ?? "/admin"}`, "SameSite=Lax", opts.httpOnly ? "HttpOnly" : "", opts.secure ? "Secure" : "", opts.maxAge === undefined ? "" : `Max-Age=${opts.maxAge}`].filter(Boolean).join("; ");
  const plugin = (reply as FastifyReply & { setCookie?: (n: string, v: string, o: Record<string, unknown>) => void }).setCookie;
  if (plugin) plugin.call(reply, name, value, { httpOnly: opts.httpOnly, secure: opts.secure, sameSite: "lax", path: opts.path ?? "/admin", maxAge: opts.maxAge });
  else appendCookie(reply, name, value, attrs);
}
function clearCookie(reply: FastifyReply, name: string, httpOnly: boolean, secure: boolean): void {
  setCookie(reply, name, "", { httpOnly, secure, maxAge: 0 });
}
function hashToken(token: string): string { return createHash("sha256").update(token).digest("hex"); }
function csrfForSession(sessionToken: string, secret: string): string { return createHmac("sha256", secret).update(`csrf:${sessionToken}`).digest("base64url"); }
function hashKey(secret: string, pepper: string): string { return createHmac("sha256", pepper).update(secret).digest("hex"); }
function requestIp(request: FastifyRequest): string { return request.ip || "unknown"; }

function routeError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ConflictError || (error instanceof Error && /duplicate|unique/i.test(error.message))) return safeError(reply, 409, "conflict");
  if (error instanceof Error && /required|must be|invalid|cannot be|positive|Invalid URL|foreign key/i.test(error.message)) return safeError(reply, 400, "invalid request");
  return safeError(reply, 500, "internal error");
}

export async function registerAdminRoutes(app: FastifyInstance, options: AdminRouteOptions): Promise<void> {
  const store: AdminStore = options.store;
  const prefix = (options.prefix ?? "/admin/api").replace(/\/$/, "");
  const sessionCookie = options.sessionCookieName ?? DEFAULT_SESSION_COOKIE;
  const csrfCookie = options.csrfCookieName ?? DEFAULT_CSRF_COOKIE;
  const ttl = options.sessionTtlSeconds ?? DEFAULT_SESSION_TTL;
  const secureCookies = options.secureCookies ?? false;
  const pepper = options.keyPepper ?? DEFAULT_PEPPER;
  const sessionSecret = options.sessionSecret ?? pepper;
  const upstreamValidationOptions = options.upstreamValidationOptions ?? { production: false, allowPrivateNetworks: true };
  const passwordHasher = options.passwordHasher ?? DefaultPasswordHasher;
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;
  const loginFailures = new Map<string, { count: number; resetAt: number }>();

  const createSession = async (admin: AdminRecord, reply: FastifyReply): Promise<void> => {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now().getTime() + ttl * 1000).toISOString();
    await store.createSession({ adminId: admin.id, tokenHash: hashToken(token), expiresAt, revokedAt: null });
    setCookie(reply, sessionCookie, token, { httpOnly: true, secure: secureCookies, maxAge: ttl });
    setCookie(reply, csrfCookie, csrfForSession(token, sessionSecret), { httpOnly: false, secure: secureCookies, maxAge: ttl });
  };
  const authenticate = async (request: FastifyRequest, reply: FastifyReply): Promise<AdminRecord | null> => {
    const token = parseCookies(request)[sessionCookie];
    if (!token || token.length < 20) { safeError(reply, 401, "unauthorized"); return null; }
    const session = await store.findSessionByTokenHash(hashToken(token));
    if (!session || session.revokedAt || Date.parse(session.expiresAt) <= now().getTime()) { safeError(reply, 401, "unauthorized"); return null; }
    const admin = await store.findAdminById(session.adminId);
    if (!admin || !admin.enabled) { safeError(reply, 401, "unauthorized"); return null; }
    (request as FastifyRequest & { openGateAdmin?: AdminRecord; openGateSession?: AdminSessionRecord }).openGateAdmin = admin;
    (request as FastifyRequest & { openGateSession?: AdminSessionRecord }).openGateSession = session;
    return admin;
  };
  const authPreHandler = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => { await authenticate(request, reply); };
  const mutationPreHandler = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const admin = await authenticate(request, reply); if (!admin) return;
    const token = parseCookies(request)[sessionCookie];
    const expected = token ? csrfForSession(token, sessionSecret) : "";
    // The CSRF cookie is intentionally readable by the browser, so accepting it
    // alone would defeat the double-submit check. Require the separate header.
    const supplied = String(request.headers["x-csrf-token"] ?? "");
    if (!expected || supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) { safeError(reply, 403, "forbidden"); return; }
  };
  const handler = (fn: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown) => async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      await fn(request, reply);
      const admin = (request as FastifyRequest & { openGateAdmin?: AdminRecord }).openGateAdmin;
      if (admin && request.method !== "GET" && request.method !== "HEAD" && reply.statusCode < 400 && store.appendAdminAudit) {
        const firstPath = request.url.split("?", 1)[0].split("/").filter(Boolean)[2] ?? "admin";
        await store.appendAdminAudit({ occurredAt: nowIso(now), adminId: admin.id, action: request.method, resource: firstPath, resourceId: typeof (request.params as Record<string, unknown>)?.id === "string" ? String((request.params as Record<string, unknown>).id) : null });
      }
    } catch (error) { routeError(reply, error); }
  };
  const getId = (request: FastifyRequest): string => String((request.params as Record<string, unknown>).id ?? "");

  app.post(`${prefix}/auth/bootstrap`, handler(async (request, reply) => {
    if (await store.countAdmins() > 0) return safeError(reply, 409, "bootstrap complete");
    const body = bodyOf(request); const email = stringValue(body.email)?.trim().toLowerCase() as string; const password = stringValue(body.password) as string;
    if (password.length < 12) return safeError(reply, 400, "invalid request");
    const admin = await store.createAdmin({ email, passwordHash: await passwordHasher.hash(password) });
    await createSession(admin, reply); return reply.code(201).send({ admin: publicAdmin(admin) });
  }));
  app.post(`${prefix}/auth/login`, handler(async (request, reply) => {
    const ip = requestIp(request); const state = loginFailures.get(ip); const timestamp = now().getTime();
    if (state && state.resetAt > timestamp && state.count >= 10) return safeError(reply, 429, "rate limited");
    const body = bodyOf(request); const email = (stringValue(body.email)?.trim().toLowerCase() ?? ""); const password = (stringValue(body.password) ?? "");
    const admin = await store.findAdminByEmail(email); const valid = !!admin && admin.enabled && await passwordHasher.verify(password, admin.passwordHash);
    if (!valid) { const next = !state || state.resetAt <= timestamp ? { count: 1, resetAt: timestamp + 15 * 60 * 1000 } : { count: state.count + 1, resetAt: state.resetAt }; loginFailures.set(ip, next); return safeError(reply, 401, "unauthorized"); }
    loginFailures.delete(ip); await createSession(admin!, reply); return reply.send({ admin: publicAdmin(admin!) });
  }));
  app.get(`${prefix}/auth/session`, handler(async (request, reply) => {
    const admin = await authenticate(request, reply); if (!admin) return; return reply.send({ admin: publicAdmin(admin) });
  }));
  app.get(`${prefix}/auth/csrf`, { preHandler: authPreHandler }, handler(async (request, reply) => {
    const token = parseCookies(request)[sessionCookie]; if (!token) return; const csrf = csrfForSession(token, sessionSecret); setCookie(reply, csrfCookie, csrf, { httpOnly: false, secure: secureCookies, maxAge: ttl }); return reply.send({ csrfToken: csrf });
  }));
  app.post(`${prefix}/auth/logout`, { preHandler: mutationPreHandler }, handler(async (request, reply) => {
    const token = parseCookies(request)[sessionCookie]; if (token) await store.revokeSession(hashToken(token), nowIso(now)); clearCookie(reply, sessionCookie, true, secureCookies); clearCookie(reply, csrfCookie, false, secureCookies); return reply.send({ ok: true });
  }));

  app.get(`${prefix}/apis`, { preHandler: authPreHandler }, handler(async (_request, reply) => reply.send({ apis: await store.listApis() })));
  app.post(`${prefix}/apis`, { preHandler: mutationPreHandler }, handler(async (request, reply) => {
    const b = bodyOf(request); const name = stringValue(b.name) as string; const slug = stringValue(b.slug) as string;
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) return safeError(reply, 400, "invalid request");
    const upstreamBaseUrl = stringValue(b.upstreamBaseUrl) as string;
    const safeUpstream = validateUpstreamUrl(upstreamBaseUrl, upstreamValidationOptions).toString().replace(/\/$/, "");
    const api = await store.createApi({ name, slug, upstreamBaseUrl: safeUpstream, enabled: boolValue(b.enabled), }); return reply.code(201).send({ api });
  }));
  app.patch(`${prefix}/apis/:id`, { preHandler: mutationPreHandler }, handler(async (request, reply) => {
    const b = bodyOf(request); const patch: Partial<ApiRecord> = {}; if (b.name !== undefined) patch.name = stringValue(b.name) as string; if (b.slug !== undefined) patch.slug = stringValue(b.slug) as string; if (b.enabled !== undefined) patch.enabled = boolValue(b.enabled); if (b.upstreamBaseUrl !== undefined) { const u = stringValue(b.upstreamBaseUrl) as string; patch.upstreamBaseUrl = validateUpstreamUrl(u, upstreamValidationOptions).toString().replace(/\/$/, ""); } const api = await store.updateApi(getId(request), patch); if (!api) return safeError(reply, 404, "not found"); return reply.send({ api });
  }));
  app.get(`${prefix}/apis/:id`, { preHandler: authPreHandler }, handler(async (request, reply) => { const api = await store.findApi(getId(request)); if (!api) return safeError(reply, 404, "not found"); return reply.send({ api }); }));

  app.get(`${prefix}/roles`, { preHandler: authPreHandler }, handler(async (_request, reply) => { const roles = await store.listRoles(); return reply.send({ roles: await Promise.all(roles.map(async (role) => ({ ...role, permissions: await store.listRolePermissions(role.id) }))) }); }));
  app.post(`${prefix}/roles`, { preHandler: mutationPreHandler }, handler(async (request, reply) => {
    const b = bodyOf(request); validateRoleLimits(b); const role = await store.createRole({ name: stringValue(b.name) as string, description: stringValue(b.description, "description", false) ?? null, rateLimitCount: positiveInt(b.rateLimitCount, "rateLimitCount"), rateLimitWindowSeconds: positiveInt(b.rateLimitWindowSeconds, "rateLimitWindowSeconds"), quotaCount: positiveInt(b.quotaCount, "quotaCount"), quotaPeriod: b.quotaPeriod === undefined || b.quotaPeriod === null ? null : (b.quotaPeriod === "day" || b.quotaPeriod === "month" ? b.quotaPeriod : (() => { throw new Error("quotaPeriod must be day or month"); })()), enabled: boolValue(b.enabled) });
    if (b.permissions !== undefined) await store.replaceRolePermissions(role.id, parsePermissions(b.permissions, role.id)); return reply.code(201).send({ role, permissions: await store.listRolePermissions(role.id) });
  }));
  app.get(`${prefix}/roles/:id`, { preHandler: authPreHandler }, handler(async (request, reply) => { const role = await store.findRole(getId(request)); if (!role) return safeError(reply, 404, "not found"); return reply.send({ role, permissions: await store.listRolePermissions(role.id) }); }));
  app.patch(`${prefix}/roles/:id`, { preHandler: mutationPreHandler }, handler(async (request, reply) => { const b = bodyOf(request); validateRoleLimits(b, true); const patch: Record<string, unknown> = {}; for (const f of ["name", "description"]) if (b[f] !== undefined) patch[f] = f === "description" ? stringValue(b[f], "description", false) ?? null : stringValue(b[f]); for (const f of ["rateLimitCount", "rateLimitWindowSeconds", "quotaCount"]) if (b[f] !== undefined) patch[f] = positiveInt(b[f], f); if (b.quotaPeriod !== undefined) patch.quotaPeriod = b.quotaPeriod === null ? null : (b.quotaPeriod === "day" || b.quotaPeriod === "month" ? b.quotaPeriod : (() => { throw new Error("quotaPeriod must be day or month"); })()); if (b.enabled !== undefined) patch.enabled = boolValue(b.enabled); const role = await store.updateRole(getId(request), patch); if (!role) return safeError(reply, 404, "not found"); if (b.permissions !== undefined) await store.replaceRolePermissions(role.id, parsePermissions(b.permissions, role.id)); return reply.send({ role, permissions: await store.listRolePermissions(role.id) }); }));
  app.put(`${prefix}/roles/:id/permissions`, { preHandler: mutationPreHandler }, handler(async (request, reply) => { const role = await store.findRole(getId(request)); if (!role) return safeError(reply, 404, "not found"); const rows = await store.replaceRolePermissions(role.id, parsePermissions(bodyOf(request).permissions, role.id)); return reply.send({ permissions: rows }); }));

  app.get(`${prefix}/consumers`, { preHandler: authPreHandler }, handler(async (_request, reply) => reply.send({ consumers: await store.listConsumers() })));
  app.post(`${prefix}/consumers`, { preHandler: mutationPreHandler }, handler(async (request, reply) => { const b = bodyOf(request); const consumer = await store.createConsumer({ name: stringValue(b.name) as string, externalReference: stringValue(b.externalReference, "externalReference", false) ?? null, enabled: boolValue(b.enabled) }); return reply.code(201).send({ consumer }); }));
  app.get(`${prefix}/consumers/:id`, { preHandler: authPreHandler }, handler(async (request, reply) => { const consumer = await store.findConsumer(getId(request)); if (!consumer) return safeError(reply, 404, "not found"); return reply.send({ consumer, assignments: await store.listAssignments({ consumerId: consumer.id }), keys: await store.listApiKeys(consumer.id) }); }));
  app.patch(`${prefix}/consumers/:id`, { preHandler: mutationPreHandler }, handler(async (request, reply) => { const b = bodyOf(request); const patch: Record<string, unknown> = {}; if (b.name !== undefined) patch.name = stringValue(b.name); if (b.externalReference !== undefined) patch.externalReference = stringValue(b.externalReference, "externalReference", false) ?? null; if (b.enabled !== undefined) patch.enabled = boolValue(b.enabled); const consumer = await store.updateConsumer(getId(request), patch); if (!consumer) return safeError(reply, 404, "not found"); return reply.send({ consumer }); }));

  app.get(`${prefix}/assignments`, { preHandler: authPreHandler }, handler(async (request, reply) => { const q = request.query as Record<string, unknown>; return reply.send({ assignments: await store.listAssignments({ consumerId: q.consumerId ? String(q.consumerId) : undefined, apiId: q.apiId ? String(q.apiId) : undefined }) }); }));
  app.post(`${prefix}/assignments`, { preHandler: mutationPreHandler }, handler(async (request, reply) => { const b = bodyOf(request); const consumerId = stringValue(b.consumerId) as string; const apiId = stringValue(b.apiId) as string; const roleId = stringValue(b.roleId) as string; if (!await store.findConsumer(consumerId) || !await store.findApi(apiId) || !await store.findRole(roleId)) return safeError(reply, 404, "not found"); const assignment = await store.upsertAssignment({ consumerId, apiId, roleId, assignedAt: nowIso(now), enabled: boolValue(b.enabled) }); return reply.code(201).send({ assignment }); }));
  app.patch(`${prefix}/assignments/:consumerId/:apiId`, { preHandler: mutationPreHandler }, handler(async (request, reply) => { const p = request.params as Record<string, unknown>; const b = bodyOf(request); const assignment = await store.updateAssignment(String(p.consumerId), String(p.apiId), { roleId: b.roleId === undefined ? undefined : stringValue(b.roleId), enabled: b.enabled === undefined ? undefined : boolValue(b.enabled) }); if (!assignment) return safeError(reply, 404, "not found"); return reply.send({ assignment }); }));

  app.get(`${prefix}/consumers/:id/keys`, { preHandler: authPreHandler }, handler(async (request, reply) => { const consumer = await store.findConsumer(getId(request)); if (!consumer) return safeError(reply, 404, "not found"); return reply.send({ keys: await store.listApiKeys(consumer.id) }); }));
  app.post(`${prefix}/consumers/:id/keys`, { preHandler: mutationPreHandler }, handler(async (request, reply) => issueKey(request, reply, getId(request), store, idFactory, pepper, now)));
  app.post(`${prefix}/keys/:keyId/rotate`, { preHandler: mutationPreHandler }, handler(async (request, reply) => { const old = await store.findApiKey(String((request.params as Record<string, unknown>).keyId)); if (!old) return safeError(reply, 404, "not found"); const result = await issueKey(request, reply, old.consumerId, store, idFactory, pepper, now); await store.revokeApiKey(old.keyId, nowIso(now)); return result; }));
  app.post(`${prefix}/keys/:keyId/revoke`, { preHandler: mutationPreHandler }, handler(async (request, reply) => { const row = await store.revokeApiKey(String((request.params as Record<string, unknown>).keyId), nowIso(now)); if (!row) return safeError(reply, 404, "not found"); return reply.send({ key: row }); }));

  app.get(`${prefix}/audit`, { preHandler: authPreHandler }, handler(async (request, reply) => {
    const q = request.query as Record<string, unknown>;
    const limit = q.limit === undefined ? undefined : Number(q.limit); const offset = q.offset === undefined ? undefined : Number(q.offset);
    if (store.listAuditEvents) return reply.send({ events: await store.listAuditEvents({ apiId: q.apiId ? String(q.apiId) : undefined, consumerId: q.consumerId ? String(q.consumerId) : undefined, outcome: q.outcome ? String(q.outcome) : undefined, requestId: q.requestId ? String(q.requestId) : undefined, limit, offset }) });
    if (store.listAdminAudit) return reply.send({ events: await store.listAdminAudit({ action: q.action ? String(q.action) : undefined, resource: q.resource ? String(q.resource) : undefined, limit, offset }) });
    return safeError(reply, 501, "not implemented");
  }));
}

function validateRoleLimits(body: Record<string, unknown>, partial = false): void {
  const has = (name: string) => Object.prototype.hasOwnProperty.call(body, name);
  if ((!partial || has("rateLimitCount") || has("rateLimitWindowSeconds")) && ((body.rateLimitCount == null) !== (body.rateLimitWindowSeconds == null))) throw new Error("rate limit count and window must be supplied together");
  if ((!partial || has("quotaCount") || has("quotaPeriod")) && ((body.quotaCount == null) !== (body.quotaPeriod == null))) throw new Error("quota count and period must be supplied together");
}

function parsePermissions(value: unknown, roleId: string): Array<Omit<RolePermissionRecord, "id" | "roleId">> {
  if (!Array.isArray(value)) throw new Error("permissions must be an array");
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new Error("invalid permission"); const p = item as Record<string, unknown>; const method = normalizeMethod(String(p.method ?? "")); const pathPattern = validatePathPattern(String(p.pathPattern ?? p.path ?? "")); if (pathPattern.length > 2000 || pathPattern.includes("?")) throw new Error("invalid permission"); return { apiId: p.apiId === undefined || p.apiId === null || p.apiId === "" ? null : String(p.apiId), method, pathPattern };
  });
}

async function issueKey(request: FastifyRequest, reply: FastifyReply, consumerId: string, store: AdminStore, idFactory: () => string, pepper: string, now: () => Date): Promise<unknown> {
  const consumer = await store.findConsumer(consumerId);
  if (!consumer) return safeError(reply, 404, "not found");
  const body = bodyOf(request);
  const issued = issueApiKey(pepper);
  const key = await store.createApiKey({
    id: idFactory(),
    consumerId,
    keyId: issued.keyId,
    secretHash: issued.secretHash,
    label: typeof body.label === "string" ? body.label : null,
    createdAt: nowIso(now),
    expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : null,
    revokedAt: null,
    lastUsedAt: null
  });
  return reply.code(201).send({ key, secret: issued.rawKey, warning: "Store this secret now; it will not be shown again." });
}

export { DefaultPasswordHasher };
