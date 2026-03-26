import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from "fastify";
import { createGateEngine, type OpenGateEngine } from "./engine.js";
import { resolveOperationalPaths } from "./observability.js";
import { normalizeCookies, normalizeHeaders, parseCookieHeader, resolveRequestId, type RequestEnvelope } from "./request.js";
import { resolveRoutePolicy } from "./policies.js";
import type {
  CreateOpenGateOptions,
  FastifyOpenGate,
  FastifyOperationalRoutesConfig,
  FastifyRegisterProtectedRouteConfig,
  OpenGate,
  OpenGateConfig
} from "./types.js";

const APP_HOOK_MARK = Symbol.for("opengate.audit.hook");
const APP_OPS_HOOK_MARK = Symbol.for("opengate.observability.hook");
const ENGINE_MARK = Symbol.for("opengate.engine");

export function createOpenGate(configOrSource?: OpenGateConfig | string | CreateOpenGateOptions): OpenGate {
  const engine = createGateEngine(configOrSource);

  return {
    config: engine.config,
    registerProtectedRoute(app, routeConfig) {
      registerProtectedRouteWithEngine(engine, app, routeConfig);
    },
    registerOperationalRoutes(app, routeConfig) {
      registerOperationalRoutesWithEngine(engine, app, routeConfig);
    },
    close() {
      return engine.close();
    },
    [ENGINE_MARK]: engine
  } as OpenGate & { [ENGINE_MARK]: OpenGateEngine };
}

export function registerProtectedRoute(app: FastifyInstance, routeConfig: FastifyRegisterProtectedRouteConfig) {
  const engine = (routeConfig.gate as FastifyOpenGate & { [ENGINE_MARK]?: OpenGateEngine })[ENGINE_MARK];
  if (!engine) {
    throw new Error("OpenGate instance is missing its internal runtime.");
  }

  registerProtectedRouteWithEngine(engine, app, routeConfig);
}

function registerProtectedRouteWithEngine(
  engine: OpenGateEngine,
  app: FastifyInstance,
  routeConfig: Omit<FastifyRegisterProtectedRouteConfig, "gate">
) {
  ensureAppHooks(app, engine);
  const routePolicy = resolveRoutePolicy(engine.config, routeConfig.path, routeConfig);

  app.route({
    method: routeConfig.method as HTTPMethods,
    url: routeConfig.path,
    handler: async (request, reply) => {
      const startedAt = process.hrtime.bigint();
      const requestEnvelope = toRequestEnvelope(request, engine.getRequestIdHeader());
      const evaluation = await engine.evaluateRequest(requestEnvelope, routePolicy, startedAt);

      request.opengate = evaluation.context;

      if (!evaluation.allowed) {
        reply.code(evaluation.statusCode).send({ error: evaluation.message });
        return;
      }

      return routeConfig.handler(request, reply);
    }
  });
}

function ensureAppHooks(app: FastifyInstance, engine: OpenGateEngine) {
  const store = app as FastifyInstance & { [APP_HOOK_MARK]?: boolean };
  if (store[APP_HOOK_MARK]) {
    return;
  }

  if (!app.hasRequestDecorator("opengate")) {
    app.decorateRequest("opengate", null);
  }

  app.addHook("onResponse", (request, reply, done) => {
    if (request.opengate) {
      engine.recordAuditEvent(request.opengate, { method: request.method, path: request.url, url: request.url }, reply.statusCode);
    }

    done();
  });

  store[APP_HOOK_MARK] = true;
}

function ensureObservabilityHooks(app: FastifyInstance, engine: OpenGateEngine, paths = resolveOperationalPaths(engine.config)) {
  const store = app as FastifyInstance & { [APP_OPS_HOOK_MARK]?: boolean };
  if (store[APP_OPS_HOOK_MARK]) {
    return;
  }

  app.route({
    method: "GET",
    url: paths.healthPath,
    handler: async () => {
      engine.recordHealthCheck(paths.healthPath);
      return { ok: true };
    }
  });

  app.route({
    method: "GET",
    url: paths.readyPath,
    handler: async () => {
      engine.recordHealthCheck(paths.readyPath);
      return { ready: true };
    }
  });

  app.route({
    method: "GET",
    url: paths.metricsPath,
    handler: async () => engine.getMetricsSnapshot()
  });

  app.route({
    method: "GET",
    url: paths.statusPath,
    handler: async () => engine.getStatusSnapshot()
  });

  store[APP_OPS_HOOK_MARK] = true;
}

function registerOperationalRoutesWithEngine(
  engine: OpenGateEngine,
  app: FastifyInstance,
  routeConfig?: Omit<FastifyOperationalRoutesConfig, "gate">
) {
  ensureObservabilityHooks(app, engine, routeConfig ? { ...resolveOperationalPaths(engine.config), ...routeConfig } : undefined);
}

function toRequestEnvelope(request: FastifyRequest, requestIdHeader: string): RequestEnvelope {
  const parsedCookies = parseCookieHeader(request.headers.cookie as string | undefined);
  const headers = normalizeHeaders(request.headers);
  const cookies = normalizeCookies({
    ...(parsedCookies ?? {}),
    ...(request.cookies ?? {})
  });

  return {
    method: request.method,
    url: request.url,
    path: request.url,
    ip: request.ip,
    requestId: resolveRequestId(headers, requestIdHeader, request.id),
    headers,
    cookies
  };
}
