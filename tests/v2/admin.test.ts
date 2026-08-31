import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { MemoryAdminStore, registerAdminRoutes } from "../../src/v2/admin/index.js";

function cookieHeader(value: unknown): string {
  const values = Array.isArray(value) ? value : [value];
  return values.filter(Boolean).map((v) => String(v).split(";", 1)[0]).join("; ");
}

describe("v2 admin HTTP API", () => {
  it("bootstraps, logs in, and requires CSRF for mutations", async () => {
    const app = Fastify();
    await registerAdminRoutes(app, { store: new MemoryAdminStore(), secureCookies: false, keyPepper: "test-pepper" });
    const bootstrap = await app.inject({ method: "POST", url: "/admin/api/auth/bootstrap", payload: { email: "admin@example.test", password: "a sufficiently long password" } });
    expect(bootstrap.statusCode).toBe(201);
    expect(bootstrap.json().admin.passwordHash).toBeUndefined();
    const cookies = cookieHeader(bootstrap.headers["set-cookie"]);
    const csrf = bootstrap.json().admin && cookies.match(/opengate_admin_csrf=([^;]+)/)?.[1];
    const denied = await app.inject({ method: "POST", url: "/admin/api/apis", headers: { cookie: cookies }, payload: { name: "Weather", slug: "weather", upstreamBaseUrl: "http://127.0.0.1:9000" } });
    expect(denied.statusCode).toBe(403);
    const allowed = await app.inject({ method: "POST", url: "/admin/api/apis", headers: { cookie: cookies, "x-csrf-token": decodeURIComponent(csrf ?? "") }, payload: { name: "Weather", slug: "weather", upstreamBaseUrl: "http://127.0.0.1:9000" } });
    expect(allowed.statusCode).toBe(201);
    await app.close();
  });

  it("creates shared roles, per-API assignments, and one-time API keys", async () => {
    const app = Fastify(); const store = new MemoryAdminStore();
    await registerAdminRoutes(app, { store, secureCookies: false });
    const boot = await app.inject({ method: "POST", url: "/admin/api/auth/bootstrap", payload: { email: "admin@example.test", password: "a sufficiently long password" } });
    const cookies = cookieHeader(boot.headers["set-cookie"]); const csrf = decodeURIComponent(cookies.match(/opengate_admin_csrf=([^;]+)/)?.[1] ?? ""); const headers = { cookie: cookies, "x-csrf-token": csrf };
    const api = await app.inject({ method: "POST", url: "/admin/api/apis", headers, payload: { name: "Reports", slug: "reports", upstreamBaseUrl: "http://localhost:3000" } });
    const role = await app.inject({ method: "POST", url: "/admin/api/roles", headers, payload: { name: "reader", quotaCount: 100, quotaPeriod: "day", permissions: [{ method: "GET", pathPattern: "/reports/*" }] } });
    const consumer = await app.inject({ method: "POST", url: "/admin/api/consumers", headers, payload: { name: "Ava" } });
    expect(api.statusCode).toBe(201); expect(role.statusCode).toBe(201); expect(consumer.statusCode).toBe(201);
    const assignment = await app.inject({ method: "POST", url: "/admin/api/assignments", headers, payload: { apiId: api.json().api.id, roleId: role.json().role.id, consumerId: consumer.json().consumer.id } });
    expect(assignment.statusCode).toBe(201);
    const key = await app.inject({ method: "POST", url: `/admin/api/consumers/${consumer.json().consumer.id}/keys`, headers, payload: { label: "demo" } });
    expect(key.statusCode).toBe(201); expect(key.json().secret).toMatch(/^ogk_[^_]+_[^_]+$/); expect(key.json().key.secretHash).toBeUndefined();
    const keys = await app.inject({ method: "GET", url: `/admin/api/consumers/${consumer.json().consumer.id}/keys`, headers: { cookie: cookies } });
    expect(keys.statusCode).toBe(200); expect(keys.json().keys[0].secretHash).toBeUndefined();
    await app.close();
  });
});
