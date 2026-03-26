import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenGate, type OpenGateLogEvent } from "../src/index.js";
import { createTestApp, createTestConfig } from "./helpers.js";

const disposers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (disposers.length > 0) {
    const dispose = disposers.pop();
    await dispose?.();
  }
});

describe("phase 5 observability", () => {
  it("exposes health, readiness, metrics, and status routes", async () => {
    const { app } = await createTestApp();
    disposers.push(() => app.close());

    const health = await app.inject({ method: "GET", url: "/healthz" });
    const ready = await app.inject({ method: "GET", url: "/readyz" });
    const initialMetrics = await app.inject({ method: "GET", url: "/metrics" });
    const initialStatus = await app.inject({ method: "GET", url: "/status" });
    await app.inject({ method: "GET", url: "/api" });
    const updatedMetrics = await app.inject({ method: "GET", url: "/metrics" });

    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ ok: true });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ ready: true });
    expect(initialMetrics.statusCode).toBe(200);
    expect(initialMetrics.json()).toMatchObject({
      requestsTotal: 0,
      allowedTotal: 0,
      blockedTotal: 0,
      routes: []
    });
    expect(initialStatus.statusCode).toBe(200);
    expect(initialStatus.json()).toMatchObject({
      status: "ready",
      backends: {
        rateLimits: "memory",
        audit: "sqlite"
      },
      metrics: {
        requestsTotal: 0
      }
    });
    expect(updatedMetrics.json()).toMatchObject({
      requestsTotal: 1,
      allowedTotal: 1,
      blockedTotal: 0,
      routes: [
        expect.objectContaining({
          routePolicyId: "public-api",
          requests: 1,
          allowed: 1,
          blocked: 0
        })
      ]
    });
  });

  it("emits structured logs with a stable request id", async () => {
    const logs: OpenGateLogEvent[] = [];
    const logger = {
      emit(event: OpenGateLogEvent) {
        logs.push(event);
      }
    };

    const gate = createOpenGate({
      config: createTestConfig({
        audit: {
          enabled: false,
          sqlitePath: ":memory:"
        }
      }),
      logger
    });

    const app = Fastify({ logger: false });
    await app.register(cookie);

    gate.registerProtectedRoute(app, {
      path: "/api",
      method: "GET",
      handler: async () => ({ ok: true })
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api",
        headers: {
          "x-request-id": "trace-123"
        }
      });

      expect(response.statusCode).toBe(200);
      expect(logs[0]).toMatchObject({
        event: "request.allowed",
        requestId: "trace-123",
        routePolicyId: "public-api",
        method: "GET",
        path: "/api",
        outcome: "allowed"
      });
    } finally {
      await app.close();
      await gate.close();
    }
  });
});


