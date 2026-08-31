import type { FastifyInstance } from "fastify";
import { CURRENT_SCHEMA_VERSION, getSchemaVersion, type SqliteDatabase } from "../data/index.js";

export type HealthStatus = { status: "ok"; service: "opengate"; uptimeSeconds: number };
export type ReadinessStatus = { status: "ready"; database: "ok"; schemaVersion: number };
export type HealthDependencies = { db: SqliteDatabase; startedAt?: number; expectedSchemaVersion?: number };

export function checkHealth(startedAt = Date.now()): HealthStatus {
  return { status: "ok", service: "opengate", uptimeSeconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) };
}

export function checkReadiness(dependencies: HealthDependencies): ReadinessStatus {
  const expected = dependencies.expectedSchemaVersion ?? CURRENT_SCHEMA_VERSION;
  if (!dependencies.db.open) throw new Error("database is closed");
  const schemaVersion = getSchemaVersion(dependencies.db);
  if (schemaVersion !== expected) throw new Error(`database schema is ${schemaVersion}; expected ${expected}`);
  dependencies.db.prepare("SELECT 1").get();
  return { status: "ready", database: "ok", schemaVersion };
}

export type HealthRouteOptions = HealthDependencies & {
  healthPath?: string;
  readyPath?: string;
  metricsPath?: string;
  metrics?: () => unknown;
  startedAt?: number;
};

/** Register liveness/readiness endpoints. Failures are intentionally generic
 * so a database error never reveals internal details to a probe/client. */
export function registerHealthRoutes(app: FastifyInstance, options: HealthRouteOptions): void {
  const startedAt = options.startedAt ?? Date.now();
  const healthPath = options.healthPath ?? "/healthz";
  const readyPath = options.readyPath ?? "/readyz";
  const metricsPath = options.metricsPath ?? "/metrics";
  app.get(healthPath, async (_request, reply) => reply.code(200).send(checkHealth(startedAt)));
  app.get(readyPath, async (_request, reply) => {
    try { return reply.code(200).send(checkReadiness(options)); }
    catch { return reply.code(503).send({ status: "not_ready" }); }
  });
  if (options.metrics) app.get(metricsPath, async (_request, reply) => reply.code(200).send(options.metrics!()));
}
