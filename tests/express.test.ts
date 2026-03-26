import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { buildExampleApp as buildExpressExampleApp } from "../examples/express-website/server.js";
import { buildExampleApp as buildFastifyExampleApp } from "../examples/website/server.js";
import { createExpressTestApp, readAuditRows, signTestJwt } from "./helpers.js";

const disposers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (disposers.length > 0) {
    const dispose = disposers.pop();
    await dispose?.();
  }
});

function readCookieHeader(setCookie: string | string[] | undefined) {
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!raw) {
    throw new Error("Expected a Set-Cookie header.");
  }

  return raw.split(";")[0];
}

describe("express adapter", () => {
  it("mirrors the core route protection and request context", async () => {
    const { app, gate } = await createExpressTestApp();
    disposers.push(() => gate.close());

    const anonymous = await request(app).get("/api");
    expect(anonymous.status).toBe(200);
    expect(anonymous.body).toEqual({
      ok: true,
      identityType: "anonymous",
      policyId: "public-api"
    });

    const token = await signTestJwt();
    const jwt = await request(app).get("/jwt").set("Authorization", `Bearer ${token}`);
    expect(jwt.status).toBe(200);
    expect(jwt.body).toEqual({
      ok: true,
      identityType: "jwt"
    });

    const apiKey = await request(app).get("/api-key").set("x-api-key", "raw-client-key-1");
    expect(apiKey.status).toBe(200);
    expect(apiKey.body).toEqual({
      ok: true,
      identityType: "api_key"
    });
  });

  it("logs audit rows and enforces rate limiting", async () => {
    const auditPath = path.join(process.cwd(), ".tmp-express-audit.sqlite");
    if (fs.existsSync(auditPath)) {
      fs.unlinkSync(auditPath);
    }
    const { app, gate } = await createExpressTestApp({
      rateLimits: {
        timezone: "UTC",
        store: "memory",
        free: { points: 1, duration: "calendar_day" },
        upgraded: { points: 1000, duration: "calendar_day" }
      },
      audit: {
        enabled: true,
        sqlitePath: auditPath,
        jwtClaimSnapshot: ["iss", "aud", "sub", "org_id", "unique_user_id"]
      }
    });

    disposers.push(async () => {
      await gate.close();
      const rows = readAuditRows(auditPath);
      expect(rows).toHaveLength(2);
      if (fs.existsSync(auditPath)) {
        fs.unlinkSync(auditPath);
      }
    });

    const first = await request(app).get("/api");
    const second = await request(app).get("/api");

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.body).toEqual({ error: "rate limited" });
  });
});

describe("example parity", () => {
  it("keeps the Fastify and Express demos aligned on the /api story", async () => {
    const fastifyApp = await buildFastifyExampleApp();
    disposers.push(() => fastifyApp.close());

    const { app: expressApp, gate } = await buildExpressExampleApp();
    disposers.push(() => gate.close());

    const fastifyAnonymous = await fastifyApp.inject({ method: "GET", url: "/api" });
    const expressAnonymous = await request(expressApp).get("/api");

    expect(fastifyAnonymous.statusCode).toBe(200);
    expect(expressAnonymous.status).toBe(200);
    expect(fastifyAnonymous.json()).toMatchObject({
      currentTime: expect.any(String),
      status: "ok"
    });
    expect(expressAnonymous.body).toMatchObject({
      currentTime: expect.any(String),
      status: "ok"
    });

    const loginResponse = await fastifyApp.inject({
      method: "POST",
      url: "/login",
      payload: new URLSearchParams({
        username: "ava",
        password: "demo-pass-1"
      }).toString(),
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      }
    });

    const cookieHeader = readCookieHeader(loginResponse.headers["set-cookie"]);

    const fastifyUpgraded = await fastifyApp.inject({
      method: "GET",
      url: "/api",
      headers: {
        cookie: cookieHeader
      }
    });

    const expressAgent = request.agent(expressApp);
    await expressAgent.post("/login").type("form").send({
      username: "ava",
      password: "demo-pass-1"
    });
    const expressUpgraded = await expressAgent.get("/api");

    expect(fastifyUpgraded.statusCode).toBe(200);
    expect(expressUpgraded.status).toBe(200);
    expect(fastifyUpgraded.json()).toMatchObject({
      currentTime: expect.any(String),
      status: "ok",
      paidTier: true
    });
    expect(expressUpgraded.body).toMatchObject({
      currentTime: expect.any(String),
      status: "ok",
      paidTier: true
    });

    const fastifyAdmin = await fastifyApp.inject({
      method: "GET",
      url: "/admin",
      headers: {
        cookie: cookieHeader
      }
    });

    const expressAdmin = await expressAgent.get("/admin");

    expect(fastifyAdmin.statusCode).toBe(200);
    expect(fastifyAdmin.body).toContain("OpenGate admin");
    expect(fastifyAdmin.body).toContain("Simulate");
    expect(expressAdmin.status).toBe(200);
    expect(expressAdmin.text).toContain("OpenGate admin");
    expect(expressAdmin.text).toContain("Simulate");
  });
});


