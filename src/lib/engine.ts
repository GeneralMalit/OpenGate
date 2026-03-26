import { createAuditLogger } from "./audit.js";
import { authorizeRequest, type AuthorizationDecision } from "./auth.js";
import { loadConfig } from "./config.js";
import type { RequestEnvelope } from "./request.js";
import { consumeRateLimit, createRateLimitStore } from "./rate_limit.js";
import { createOpenGateTelemetry } from "./observability.js";
import type {
  AuditEvent,
  CreateOpenGateOptions,
  OpenGateConfig,
  OpenGateMetricsSnapshot,
  OpenGateRequestContext,
  OpenGateStatusSnapshot,
  ResolvedRoutePolicy
} from "./types.js";

export type GateEvaluationResult =
  | {
      allowed: true;
      context: OpenGateRequestContext;
    }
  | {
      allowed: false;
      statusCode: number;
      message: string;
      context: OpenGateRequestContext;
    };

export type OpenGateEngine = {
  config: OpenGateConfig;
  evaluateRequest: (
    request: RequestEnvelope,
    routePolicy: ResolvedRoutePolicy,
    startedAt: bigint
  ) => Promise<GateEvaluationResult>;
  buildAuditEvent: (
    context: OpenGateRequestContext,
    request: Pick<RequestEnvelope, "method" | "path" | "url">,
    statusCode: number
  ) => AuditEvent;
  getMetricsSnapshot: () => OpenGateMetricsSnapshot;
  getStatusSnapshot: () => OpenGateStatusSnapshot;
  getRequestIdHeader: () => string;
  recordHealthCheck: (path: string) => void;
  recordAuditEvent: (
    context: OpenGateRequestContext,
    request: Pick<RequestEnvelope, "method" | "path" | "url">,
    statusCode: number
  ) => void;
  close: () => Promise<void>;
};

export function createGateEngine(configOrSource?: OpenGateConfig | string | CreateOpenGateOptions): OpenGateEngine {
  const normalized = normalizeCreateOptions(configOrSource);
  const config = loadConfig(normalized.configPath ?? normalized.config);
  const rateLimitStore = createRateLimitStore(config, normalized.rateLimitStore);
  const telemetry = createOpenGateTelemetry(config, normalized.logger);
  const auditLogger = createAuditLogger(config, {
    onBatchWritten(events) {
      telemetry.recordAuditBatchWritten(events);
    },
    onBatchFailed(events, error) {
      telemetry.recordAuditBatchFailed(events, error);
    },
    onBatchDropped(events) {
      telemetry.recordAuditBatchDropped(events);
    }
  });
  const buildAuditEvent: OpenGateEngine["buildAuditEvent"] = (context, request, statusCode) => ({
    occurredAt: new Date().toISOString(),
    requestId: context.requestId,
    routePolicyId: context.routePolicy.id,
    identityType: context.identity.identityType,
    organizationId: "organizationId" in context.identity ? context.identity.organizationId : null,
    secondaryIdentifier:
      "secondaryIdentifier" in context.identity ? context.identity.secondaryIdentifier : null,
    method: request.method,
    path: request.path ?? request.url,
    statusCode,
    latencyMs: Number(process.hrtime.bigint() - context.startedAt) / 1_000_000,
    outcome: context.outcome,
    blockReason: context.blockReason,
    jwtClaimSnapshot: context.jwtClaimSnapshot
  });

  return {
    config,
    async evaluateRequest(request, routePolicy, startedAt) {
      const authDecision = await authorizeRequest(config, routePolicy, request);
      const context = createContext(startedAt, request.requestId, routePolicy, authDecision);

      if (!authDecision.allowed) {
        return {
          allowed: false,
          statusCode: authDecision.statusCode,
          message: authDecision.message,
          context
        };
      }

      const rateLimitDecision = await consumeRateLimit(rateLimitStore, config, authDecision.identity);
      if (!rateLimitDecision.allowed) {
        context.outcome = "blocked";
        context.blockReason = "rate_limited";

        return {
          allowed: false,
          statusCode: 429,
          message: "rate limited",
          context
        };
      }

      return {
        allowed: true,
        context
      };
    },
    buildAuditEvent,
    getMetricsSnapshot() {
      return telemetry.getMetricsSnapshot();
    },
    getStatusSnapshot() {
      return telemetry.getStatusSnapshot();
    },
    getRequestIdHeader() {
      return telemetry.getRequestIdHeader();
    },
    recordHealthCheck(path) {
      telemetry.recordHealthCheck(path);
    },
    recordAuditEvent(context, request, statusCode) {
      if (context.auditLogged) {
        return;
      }

      context.auditLogged = true;
      const logEvent = telemetry.recordRequestFinalized(context, request, statusCode);
      void Promise.resolve(normalized.logger?.emit(logEvent)).catch(() => undefined);

      if (auditLogger) {
        auditLogger.log(buildAuditEvent(context, request, statusCode));
      }
    },
    async close() {
      await Promise.all([
        auditLogger?.close() ?? Promise.resolve(),
        rateLimitStore.close?.() ?? Promise.resolve(),
        normalized.logger?.close?.() ?? Promise.resolve()
      ]);
    }
  };
}

function createContext(
  startedAt: bigint,
  requestId: string,
  routePolicy: ResolvedRoutePolicy,
  authDecision: AuthorizationDecision
): OpenGateRequestContext {
  return {
    startedAt,
    requestId,
    routePolicy,
    identity: authDecision.identity,
    outcome: authDecision.allowed ? "allowed" : "blocked",
    blockReason: authDecision.allowed ? null : authDecision.blockReason,
    jwtClaimSnapshot: authDecision.jwtClaimSnapshot,
    auditLogged: false
  };
}

function normalizeCreateOptions(input?: OpenGateConfig | string | CreateOpenGateOptions): CreateOpenGateOptions {
  if (!input) {
    return {};
  }

  if (typeof input === "string") {
    return { configPath: input };
  }

  if ("routePolicies" in input) {
    return { config: input };
  }

  return input;
}
