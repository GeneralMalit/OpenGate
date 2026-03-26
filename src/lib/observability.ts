import type {
  AuditEvent,
  OpenGateConfig,
  OpenGateLogEvent,
  OpenGateLoggerAdapter,
  OpenGateMetricsSnapshot,
  OpenGateRouteMetricSnapshot,
  OpenGateStatusSnapshot,
  OpenGateRequestContext
} from "./types.js";
import type { RequestEnvelope } from "./request.js";

const DEFAULT_REQUEST_ID_HEADER = "x-request-id";
const DEFAULT_HEALTH_PATH = "/healthz";
const DEFAULT_READY_PATH = "/readyz";
const DEFAULT_METRICS_PATH = "/metrics";
const DEFAULT_STATUS_PATH = "/status";

const AUTH_FAILURE_BLOCK_REASONS = new Set([
  "api_key_required",
  "authenticated_required",
  "credential_mismatch",
  "insufficient_scope",
  "invalid_api_key",
  "jwt_required",
  "missing_claim",
  "missing_secondary_identifier",
  "organization_disabled",
  "organization_not_found",
  "policy_disabled",
  "unsupported_access_mode",
  "unsupported_jwt_issuer"
]);

export type AuditWriteHooks = {
  onBatchWritten?: (events: AuditEvent[]) => void;
  onBatchFailed?: (events: AuditEvent[], error: unknown) => void;
  onBatchDropped?: (events: AuditEvent[]) => void;
};

type RouteMetricState = OpenGateRouteMetricSnapshot;

type TelemetryCounts = {
  requestsTotal: number;
  allowedTotal: number;
  blockedTotal: number;
  authFailuresTotal: number;
  rateLimitedTotal: number;
  auditWritesTotal: number;
  auditFailuresTotal: number;
  auditDroppedTotal: number;
  healthChecksTotal: number;
  readyChecksTotal: number;
};

export type OpenGateTelemetry = {
  recordRequestFinalized: (
    context: OpenGateRequestContext,
    request: Pick<RequestEnvelope, "method" | "path" | "url">,
    statusCode: number
  ) => OpenGateLogEvent;
  recordAuditBatchWritten: (events: AuditEvent[]) => void;
  recordAuditBatchFailed: (events: AuditEvent[], error: unknown) => void;
  recordAuditBatchDropped: (events: AuditEvent[]) => void;
  recordHealthCheck: (path: string) => void;
  getMetricsSnapshot: () => OpenGateMetricsSnapshot;
  getStatusSnapshot: () => OpenGateStatusSnapshot;
  getRequestIdHeader: () => string;
};

export function createOpenGateTelemetry(
  config: OpenGateConfig,
  logger?: OpenGateLoggerAdapter | null
): OpenGateTelemetry {
  const startedAt = Date.now();
  const counts: TelemetryCounts = {
    requestsTotal: 0,
    allowedTotal: 0,
    blockedTotal: 0,
    authFailuresTotal: 0,
    rateLimitedTotal: 0,
    auditWritesTotal: 0,
    auditFailuresTotal: 0,
    auditDroppedTotal: 0,
    healthChecksTotal: 0,
    readyChecksTotal: 0
  };
  const routeMetrics = new Map<string, RouteMetricState>();
  const observability = config.observability ?? {};
  const requestIdHeader = observability.requestIdHeader ?? DEFAULT_REQUEST_ID_HEADER;
  const getMetricsSnapshot = () => ({
    requestsTotal: counts.requestsTotal,
    allowedTotal: counts.allowedTotal,
    blockedTotal: counts.blockedTotal,
    authFailuresTotal: counts.authFailuresTotal,
    rateLimitedTotal: counts.rateLimitedTotal,
    auditWritesTotal: counts.auditWritesTotal,
    auditFailuresTotal: counts.auditFailuresTotal,
    auditDroppedTotal: counts.auditDroppedTotal,
    healthChecksTotal: counts.healthChecksTotal,
    readyChecksTotal: counts.readyChecksTotal,
    routes: Array.from(routeMetrics.values()).sort((left, right) => left.routePolicyId.localeCompare(right.routePolicyId))
  });
  const getStatusSnapshot = () => ({
    status: "ready" as const,
    startedAt: new Date(startedAt).toISOString(),
    uptimeMs: Date.now() - startedAt,
    requestIdHeader,
    backends: {
      rateLimits: config.rateLimits.store ?? "memory",
      audit: config.audit.backend ?? "sqlite"
    },
    metrics: getMetricsSnapshot()
  });

  return {
    recordRequestFinalized(context, request, statusCode) {
      counts.requestsTotal += 1;

      const routeMetric = getRouteMetric(routeMetrics, context.routePolicy.id);
      routeMetric.requests += 1;

      if (context.outcome === "allowed") {
        counts.allowedTotal += 1;
        routeMetric.allowed += 1;
      } else {
        counts.blockedTotal += 1;
        routeMetric.blocked += 1;

        if (context.blockReason === "rate_limited") {
          counts.rateLimitedTotal += 1;
          routeMetric.rateLimited += 1;
        } else if (context.blockReason && AUTH_FAILURE_BLOCK_REASONS.has(context.blockReason)) {
          counts.authFailuresTotal += 1;
          routeMetric.authFailures += 1;
        } else {
          counts.authFailuresTotal += 1;
          routeMetric.authFailures += 1;
        }
      }

      return {
        timestamp: new Date().toISOString(),
        level: context.outcome === "allowed" ? "info" : "warn",
        event: context.outcome === "allowed" ? "request.allowed" : "request.blocked",
        requestId: context.requestId,
        routePolicyId: context.routePolicy.id,
        method: request.method,
        path: request.path ?? request.url,
        identityType: context.identity.identityType,
        tier: context.identity.tier,
        statusCode,
        outcome: context.outcome,
        blockReason: context.blockReason,
        latencyMs: Number(process.hrtime.bigint() - context.startedAt) / 1_000_000
      };
    },
    recordAuditBatchWritten(events) {
      if (!events.length) {
        return;
      }

      counts.auditWritesTotal += events.length;
      for (const event of events) {
        getRouteMetric(routeMetrics, event.routePolicyId).auditWrites += 1;
      }
    },
    recordAuditBatchFailed(events, error) {
      if (!events.length) {
        return;
      }

      counts.auditFailuresTotal += events.length;
      for (const event of events) {
        getRouteMetric(routeMetrics, event.routePolicyId).auditFailures += 1;
      }

      void emit(logger, {
        timestamp: new Date().toISOString(),
        level: "error",
        event: "audit.write.failed",
        requestId: events[0]?.requestId ?? "unknown",
        routePolicyId: events[0]?.routePolicyId,
        method: events[0]?.method,
        path: events[0]?.path,
        statusCode: events[0]?.statusCode,
        outcome: events[0]?.outcome,
        blockReason: events[0]?.blockReason,
        details: {
          count: events.length,
          error: stringifyError(error)
        }
      });
    },
    recordAuditBatchDropped(events) {
      if (!events.length) {
        return;
      }

      counts.auditDroppedTotal += events.length;
      for (const event of events) {
        getRouteMetric(routeMetrics, event.routePolicyId).auditDropped += 1;
      }
      void emit(logger, {
        timestamp: new Date().toISOString(),
        level: "warn",
        event: "audit.write.dropped",
        requestId: events[0]?.requestId ?? "unknown",
        routePolicyId: events[0]?.routePolicyId,
        method: events[0]?.method,
        path: events[0]?.path,
        statusCode: events[0]?.statusCode,
        outcome: events[0]?.outcome,
        blockReason: events[0]?.blockReason,
        details: {
          count: events.length
        }
      });
    },
    recordHealthCheck(path) {
      if (path === (observability.readyPath ?? DEFAULT_READY_PATH)) {
        counts.readyChecksTotal += 1;
      } else if (path === (observability.healthPath ?? DEFAULT_HEALTH_PATH)) {
        counts.healthChecksTotal += 1;
      }
    },
    getMetricsSnapshot() {
      return getMetricsSnapshot();
    },
    getStatusSnapshot() {
      return getStatusSnapshot();
    },
    getRequestIdHeader() {
      return requestIdHeader;
    }
  };
}

export function createConsoleLoggerAdapter(): OpenGateLoggerAdapter {
  return {
    emit(event) {
      const serialized = JSON.stringify(event);
      if (event.level === "error") {
        console.error(serialized);
        return;
      }

      if (event.level === "warn") {
        console.warn(serialized);
        return;
      }

      console.info(serialized);
    }
  };
}

export function resolveOperationalPaths(config: OpenGateConfig) {
  const observability = config.observability ?? {};

  return {
    healthPath: observability.healthPath ?? DEFAULT_HEALTH_PATH,
    readyPath: observability.readyPath ?? DEFAULT_READY_PATH,
    metricsPath: observability.metricsPath ?? DEFAULT_METRICS_PATH,
    statusPath: observability.statusPath ?? DEFAULT_STATUS_PATH
  };
}

function getRouteMetric(routeMetrics: Map<string, RouteMetricState>, routePolicyId: string): RouteMetricState {
  const existing = routeMetrics.get(routePolicyId);
  if (existing) {
    return existing;
  }

  const created: RouteMetricState = {
    routePolicyId,
    requests: 0,
    allowed: 0,
    blocked: 0,
    authFailures: 0,
    rateLimited: 0,
    auditWrites: 0,
    auditFailures: 0,
    auditDropped: 0
  };
  routeMetrics.set(routePolicyId, created);
  return created;
}

async function emit(logger: OpenGateLoggerAdapter | null | undefined, event: OpenGateLogEvent) {
  if (!logger) {
    return;
  }

  await Promise.resolve(logger.emit(event)).catch(() => undefined);
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === "string" ? error : "unknown error";
}
