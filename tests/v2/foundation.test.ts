import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { issueApiKey } from "../../src/v2/domain/keys.js";
import { validateRuntimeConfig, RuntimeConfigError } from "../../src/v2/config.js";
import { closeDatabase, getSchemaVersion, openDatabase } from "../../src/v2/data/index.js";
import { SqliteAdminStore } from "../../src/v2/data/sqlite-store.js";
import { checkHealth, checkReadiness, registerHealthRoutes } from "../../src/v2/observability/health.js";
import { createStructuredLogger } from "../../src/v2/observability/logger.js";

const secret = "a".repeat(32);

describe("v2 foundation", () => {
  it("validates runtime secrets, defaults, and production transport", () => {
    const config = validateRuntimeConfig({ keyPepper: secret, sessionSecret: secret });
    expect(config.databasePath).toContain("opengate.sqlite");
    expect(config.port).toBe(8080);
    expect(config.apiKeyHeader).toBe("X-OpenGate-Key");

    expect(() => validateRuntimeConfig({ keyPepper: "short", sessionSecret: secret })).toThrow(RuntimeConfigError);
    expect(() => validateRuntimeConfig({ keyPepper: secret, sessionSecret: secret, environment: "production", publicBaseUrl: "http://gateway.example" })).toThrow(/HTTPS/);
  });

  it("runs an idempotent SQLite migration with all v2 tables", () => {
    const db = openDatabase(":memory:");
    expect(getSchemaVersion(db)).toBe(1);
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name);
    expect(names).toEqual(expect.arrayContaining(["admins", "admin_sessions", "apis", "roles", "role_permissions", "consumers", "consumer_api_roles", "api_keys", "limit_buckets", "audit_events"]));
    db.pragma("foreign_keys");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    closeDatabase(db);
  });

  it("persists control-plane records and resolves a gateway context", () => {
    const db = openDatabase(":memory:");
    const store = new SqliteAdminStore(db);
    const api = store.createApi({ name: "Reports", slug: "reports", upstreamBaseUrl: "https://upstream.example", enabled: true });
    const role = store.createRole({ name: "reader", description: null, rateLimitCount: 10, rateLimitWindowSeconds: 60, quotaCount: 100, quotaPeriod: "day", enabled: true });
    store.replaceRolePermissions(role.id, [{ apiId: null, method: "get", pathPattern: "/reports/*" }]);
    const consumer = store.createConsumer({ name: "Ava", externalReference: null, enabled: true });
    store.upsertAssignment({ consumerId: consumer.id, apiId: api.id, roleId: role.id, assignedAt: new Date().toISOString(), enabled: true });
    const issued = issueApiKey(secret);
    store.createApiKey({ id: "key-record", consumerId: consumer.id, keyId: issued.keyId, secretHash: issued.secretHash, label: "demo", createdAt: new Date().toISOString(), expiresAt: null, revokedAt: null, lastUsedAt: null });

    expect(store.findApiKey(issued.keyId)).not.toHaveProperty("secretHash");
    const context = store.findGatewayContext(issued.keyId, api.id);
    expect(context?.consumerEnabled).toBe(true);
    expect(context?.assignment?.roleId).toBe(role.id);
    expect(context?.permissions[0]?.method).toBe("GET");
    closeDatabase(db);
  });

  it("reports liveness/readiness and redacts secrets in structured logs", async () => {
    const db = openDatabase(":memory:");
    expect(checkHealth().status).toBe("ok");
    expect(checkReadiness({ db }).database).toBe("ok");
    const app = Fastify();
    registerHealthRoutes(app, { db });
    await app.ready();
    expect((await app.inject("/healthz")).statusCode).toBe(200);
    expect((await app.inject("/readyz")).statusCode).toBe(200);
    const lines: string[] = [];
    createStructuredLogger({}, (line) => lines.push(line)).emit({ level: "info", event: "test", token: "never-log", nested: { password: "never-log" } });
    expect(lines[0]).not.toContain("never-log");
    await app.close();
    closeDatabase(db);
  });
});
