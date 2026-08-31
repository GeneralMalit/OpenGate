import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { validateRuntimeConfig } from "../../src/v2/config.js";
import { closeDatabase, openDatabase } from "../../src/v2/data/index.js";
import { issueApiKey } from "../../src/v2/domain/index.js";
import { createOpenGateV2 } from "../../src/v2/server.js";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(resources.splice(0).map((close) => close()));
});

describe("v2 universal gateway", () => {
  it("authorizes one assigned role, proxies permitted traffic, audits it, and blocks quota exhaustion", async () => {
    const upstream = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ method: request.method, path: request.url, leakedKey: request.headers["x-opengate-key"] ?? null }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    resources.push(async () => new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve())));
    const port = (upstream.address() as AddressInfo).port;
    const db = openDatabase(":memory:");
    const config = validateRuntimeConfig({
      databasePath: ":memory:",
      keyPepper: "p".repeat(48),
      sessionSecret: "s".repeat(48),
      publicBaseUrl: "http://127.0.0.1:8080",
      environment: "test"
    });
    const gateway = await createOpenGateV2({ config, db });
    resources.push(async () => { await gateway.close(); closeDatabase(db); });

    const api = gateway.store.createApi({ name: "Weather", slug: "weather", upstreamBaseUrl: `http://127.0.0.1:${port}`, enabled: true });
    const role = gateway.store.createRole({
      name: "reader",
      description: null,
      rateLimitCount: 5,
      rateLimitWindowSeconds: 60,
      quotaCount: 1,
      quotaPeriod: "day",
      enabled: true
    });
    gateway.store.replaceRolePermissions(role.id, [{ apiId: api.id, method: "GET", pathPattern: "/reports/*" }]);
    const consumer = gateway.store.createConsumer({ name: "Ava", externalReference: null, enabled: true });
    gateway.store.upsertAssignment({ consumerId: consumer.id, apiId: api.id, roleId: role.id, assignedAt: new Date().toISOString(), enabled: true });
    const issued = issueApiKey(config.keyPepper);
    gateway.store.createApiKey({
      id: "key-1", consumerId: consumer.id, keyId: issued.keyId, secretHash: issued.secretHash,
      label: "primary", createdAt: new Date().toISOString(), expiresAt: null, revokedAt: null, lastUsedAt: null
    });

    const allowed = await gateway.app.inject({ method: "GET", url: "/apis/weather/reports/today?format=json", headers: { "x-opengate-key": issued.rawKey } });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toEqual({ method: "GET", path: "/reports/today?format=json", leakedKey: null });

    const quotaBlocked = await gateway.app.inject({ method: "GET", url: "/apis/weather/reports/tomorrow", headers: { "x-opengate-key": issued.rawKey } });
    expect(quotaBlocked.statusCode).toBe(429);
    expect(quotaBlocked.json()).toEqual({ error: "rate limited" });

    const forbidden = await gateway.app.inject({ method: "POST", url: "/apis/weather/reports/today", headers: { "x-opengate-key": issued.rawKey } });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toEqual({ error: "forbidden" });

    const events = db.prepare("SELECT outcome, reason FROM audit_events ORDER BY id").all() as Array<{ outcome: string; reason: string | null }>;
    expect(events).toEqual([
      { outcome: "allowed", reason: null },
      { outcome: "blocked", reason: "quota" },
      { outcome: "blocked", reason: "permission_denied" }
    ]);
  });

  it("keeps one consumer's roles and quota counters separate for each API", async () => {
    const upstream = createServer((_request, response) => response.end("ok"));
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    resources.push(async () => new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve())));
    const port = (upstream.address() as AddressInfo).port;
    const db = openDatabase(":memory:");
    const config = validateRuntimeConfig({ databasePath: ":memory:", keyPepper: "p".repeat(48), sessionSecret: "s".repeat(48), publicBaseUrl: "http://127.0.0.1:8080", environment: "test" });
    const gateway = await createOpenGateV2({ config, db });
    resources.push(async () => { await gateway.close(); closeDatabase(db); });
    const weather = gateway.store.createApi({ name: "Weather", slug: "weather", upstreamBaseUrl: `http://127.0.0.1:${port}`, enabled: true });
    const billing = gateway.store.createApi({ name: "Billing", slug: "billing", upstreamBaseUrl: `http://127.0.0.1:${port}`, enabled: true });
    const weatherRole = gateway.store.createRole({ name: "weather-reader", description: null, rateLimitCount: null, rateLimitWindowSeconds: null, quotaCount: 1, quotaPeriod: "day", enabled: true });
    const billingRole = gateway.store.createRole({ name: "billing-reader", description: null, rateLimitCount: null, rateLimitWindowSeconds: null, quotaCount: 1, quotaPeriod: "day", enabled: true });
    gateway.store.replaceRolePermissions(weatherRole.id, [{ apiId: weather.id, method: "GET", pathPattern: "/*" }]);
    gateway.store.replaceRolePermissions(billingRole.id, [{ apiId: billing.id, method: "GET", pathPattern: "/*" }]);
    const consumer = gateway.store.createConsumer({ name: "Ava", externalReference: "ava", enabled: true });
    gateway.store.upsertAssignment({ consumerId: consumer.id, apiId: weather.id, roleId: weatherRole.id, assignedAt: new Date().toISOString(), enabled: true });
    gateway.store.upsertAssignment({ consumerId: consumer.id, apiId: billing.id, roleId: billingRole.id, assignedAt: new Date().toISOString(), enabled: true });
    const key = issueApiKey(config.keyPepper);
    gateway.store.createApiKey({ id: "key-2", consumerId: consumer.id, keyId: key.keyId, secretHash: key.secretHash, label: "shared", createdAt: new Date().toISOString(), expiresAt: null, revokedAt: null, lastUsedAt: null });

    expect((await gateway.app.inject({ method: "GET", url: "/apis/weather/a", headers: { "x-opengate-key": key.rawKey } })).statusCode).toBe(200);
    expect((await gateway.app.inject({ method: "GET", url: "/apis/weather/b", headers: { "x-opengate-key": key.rawKey } })).statusCode).toBe(429);
    expect((await gateway.app.inject({ method: "GET", url: "/apis/billing/a", headers: { "x-opengate-key": key.rawKey } })).statusCode).toBe(200);
  });
});
