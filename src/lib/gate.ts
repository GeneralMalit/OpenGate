import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createAuditLogger } from "./audit.js";
import { authorizeRequest } from "./auth.js";
import { loadConfig } from "./config.js";
import { resolveRoutePolicy } from "./policies.js";
import { consumeRateLimit, createRateLimitStore } from "./rate_limit.js";
import type {
  AuditEvent,
  CreateOpenGateOptions,
  OpenGate,
  OpenGateConfig,
  OpenGateRequestContext,
  RegisterProtectedRouteConfig,
  RequestIdentity
} from "./types.js";

const APP_HOOK_MARK = Symbol.for("opengate.audit.hook");

export function createOpenGate(configOrSource?: OpenGateConfig | string | CreateOpenGateOptions): OpenGate {
  const normalized = normalizeCreateOptions(configOrSource);
  const config = loadConfig(normalized.configPath ?? normalized.config);
  const rateLimitStore = createRateLimitStore(config, normalized.rateLimitStore);
  const auditLogger = createAuditLogger(config);

  return {
    config,
    registerProtectedRoute(app, routeConfig) {
      registerProtectedRoute(app, {
        ...routeConfig,
        gate: this
      });
    },
    close() {
      auditLogger?.close();
    }
  };

  function evaluateRateLimit(identity: RequestIdentity) {
    const result = consumeRateLimit(rateLimitStore, config, identity);
    if (!result.allowed) {
      return {
        allowed: false as const,
        statusCode: 429,
        message: "rate limited",
        blockReason: "rate_limited"
      };
    }

    return { allowed: true as const };
  }

  function logAuditEvent(request: FastifyRequest, reply: FastifyReply) {
    const context = request.opengate;
    if (!context || context.auditLogged || !auditLogger) {
      return;
    }

    context.auditLogged = true;
    const event = buildAuditEvent(context, request, reply);
    auditLogger.log(event);
  }

  function buildAuditEvent(
    context: OpenGateRequestContext,
    request: FastifyRequest,
    reply: FastifyReply
  ): AuditEvent {
    return {
      occurredAt: new Date().toISOString(),
      routePolicyId: context.routePolicy.id,
      identityType: context.identity.identityType,
      organizationId: "organizationId" in context.identity ? context.identity.organizationId : null,
      secondaryIdentifier:
        "secondaryIdentifier" in context.identity ? context.identity.secondaryIdentifier : null,
      method: request.method,
      path: request.url,
      statusCode: reply.statusCode,
      latencyMs: Number(process.hrtime.bigint() - context.startedAt) / 1_000_000,
      outcome: context.outcome,
      blockReason: context.blockReason,
      jwtClaimSnapshot: context.jwtClaimSnapshot
    };
  }

  function ensureAppHooks(app: FastifyInstance) {
    const store = app as FastifyInstance & { [APP_HOOK_MARK]?: boolean };
    if (store[APP_HOOK_MARK]) {
      return;
    }

    if (!app.hasRequestDecorator("opengate")) {
      app.decorateRequest("opengate", null);
    }

    app.addHook("onResponse", (request, reply, done) => {
      logAuditEvent(request, reply);
      done();
    });

    store[APP_HOOK_MARK] = true;
  }

  function registerProtectedRouteInternal(app: FastifyInstance, routeConfig: RegisterProtectedRouteConfig) {
    ensureAppHooks(app);
    const routePolicy = resolveRoutePolicy(config, routeConfig.path, routeConfig);

    app.route({
      method: routeConfig.method,
      url: routeConfig.path,
      handler: async (request, reply) => {
        const startedAt = process.hrtime.bigint();
        const authDecision = await authorizeRequest(config, routePolicy, request);

        if (!authDecision.allowed) {
          request.opengate = {
            startedAt,
            routePolicy,
            identity: authDecision.identity,
            outcome: "blocked",
            blockReason: authDecision.blockReason,
            jwtClaimSnapshot: authDecision.jwtClaimSnapshot,
            auditLogged: false
          };
          reply.code(authDecision.statusCode).send({ error: authDecision.message });
          return;
        }

        const rateLimitDecision = evaluateRateLimit(authDecision.identity);
        if (!rateLimitDecision.allowed) {
          request.opengate = {
            startedAt,
            routePolicy,
            identity: authDecision.identity,
            outcome: "blocked",
            blockReason: rateLimitDecision.blockReason,
            jwtClaimSnapshot: authDecision.jwtClaimSnapshot,
            auditLogged: false
          };
          reply.code(rateLimitDecision.statusCode).send({ error: rateLimitDecision.message });
          return;
        }

        request.opengate = {
          startedAt,
          routePolicy,
          identity: authDecision.identity,
          outcome: "allowed",
          blockReason: null,
          jwtClaimSnapshot: authDecision.jwtClaimSnapshot,
          auditLogged: false
        };

        return routeConfig.handler(request, reply);
      }
    });
  }

  function registerProtectedRoute(app: FastifyInstance, routeConfig: RegisterProtectedRouteConfig) {
    registerProtectedRouteInternal(app, routeConfig);
  }
}

export function registerProtectedRoute(app: FastifyInstance, routeConfig: RegisterProtectedRouteConfig) {
  routeConfig.gate.registerProtectedRoute(app, {
    path: routeConfig.path,
    method: routeConfig.method,
    handler: routeConfig.handler,
    policyId: routeConfig.policyId,
    accessMode: routeConfig.accessMode,
    requiredScopes: routeConfig.requiredScopes,
    enabled: routeConfig.enabled
  });
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
