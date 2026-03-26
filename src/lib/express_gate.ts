import type { Application, Request, Response, Router } from "express";
import { createGateEngine, type OpenGateEngine } from "./engine.js";
import { resolveOperationalPaths } from "./observability.js";
import { normalizeCookies, normalizeHeaders, parseCookieHeader, resolveRequestId, type RequestEnvelope } from "./request.js";
import { resolveRoutePolicy } from "./policies.js";
import type {
  CreateOpenGateOptions,
  ExpressOpenGate,
  ExpressOperationalRoutesConfig,
  ExpressRegisterProtectedRouteConfig,
  OpenGateConfig
} from "./types.js";

const ENGINE_MARK = Symbol.for("opengate.express.engine");
const APP_OPS_HOOK_MARK = Symbol.for("opengate.express.observability.hook");

export function createExpressOpenGate(configOrSource?: OpenGateConfig | string | CreateOpenGateOptions): ExpressOpenGate {
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
  } as ExpressOpenGate & { [ENGINE_MARK]: OpenGateEngine };
}

export function registerProtectedRoute(
  app: Application | Router,
  routeConfig: ExpressRegisterProtectedRouteConfig
) {
  const engine = (routeConfig.gate as ExpressOpenGate & { [ENGINE_MARK]?: OpenGateEngine })[ENGINE_MARK];
  if (!engine) {
    throw new Error("OpenGate instance is missing its internal runtime.");
  }

  registerProtectedRouteWithEngine(engine, app, routeConfig);
}

function registerProtectedRouteWithEngine(
  engine: OpenGateEngine,
  app: Application | Router,
  routeConfig: Omit<ExpressRegisterProtectedRouteConfig, "gate">
) {
  const routePolicy = resolveRoutePolicy(engine.config, routeConfig.path, routeConfig);
  const method = routeConfig.method.toLowerCase();
  const routeRegistrar = (app as Application & Record<string, unknown>)[method] as
    | ((path: string, ...handlers: Array<(request: Request, response: Response, next: (error?: unknown) => void) => unknown>) => unknown)
    | undefined;

  if (typeof routeRegistrar !== "function") {
    throw new Error(`Express application does not support method "${routeConfig.method}".`);
  }

  routeRegistrar.call(app, routeConfig.path, async (request: Request, response: Response, next) => {
    const startedAt = process.hrtime.bigint();
    const requestEnvelope = toRequestEnvelope(request, engine.getRequestIdHeader());
    const evaluation = await engine.evaluateRequest(requestEnvelope, routePolicy, startedAt);

    request.opengate = evaluation.context;
    response.on("finish", () => {
      if (request.opengate) {
        engine.recordAuditEvent(request.opengate, {
          method: request.method,
          path: request.path ?? request.originalUrl ?? request.url,
          url: request.originalUrl ?? request.url
        }, response.statusCode);
      }
    });

    if (!evaluation.allowed) {
      response.status(evaluation.statusCode).json({ error: evaluation.message });
      return;
    }

    try {
      const result = await routeConfig.handler(request, response);
      if (!response.headersSent && result !== undefined) {
        response.send(result);
      }
    } catch (error) {
      next(error);
    }
  });
}

function ensureObservabilityRoutes(
  app: Application | Router,
  engine: OpenGateEngine,
  paths = resolveOperationalPaths(engine.config)
) {
  const store = app as Application & { [APP_OPS_HOOK_MARK]?: boolean };
  if (store[APP_OPS_HOOK_MARK]) {
    return;
  }

  const register = (method: "get", routePath: string, handler: (request: Request, response: Response) => void) => {
    const routeRegistrar = (app as Application & Record<string, unknown>)[method] as
      | ((path: string, ...handlers: Array<(request: Request, response: Response, next: (error?: unknown) => void) => unknown>) => unknown)
      | undefined;

    if (typeof routeRegistrar !== "function") {
      throw new Error(`Express application does not support method "${method.toUpperCase()}".`);
    }

    routeRegistrar.call(app, routePath, handler);
  };

  register("get", paths.healthPath, (_request, response) => {
    engine.recordHealthCheck(paths.healthPath);
    response.json({ ok: true });
  });

  register("get", paths.readyPath, (_request, response) => {
    engine.recordHealthCheck(paths.readyPath);
    response.json({ ready: true });
  });

  register("get", paths.metricsPath, (_request, response) => {
    response.json(engine.getMetricsSnapshot());
  });

  register("get", paths.statusPath, (_request, response) => {
    response.json(engine.getStatusSnapshot());
  });

  store[APP_OPS_HOOK_MARK] = true;
}

function registerOperationalRoutesWithEngine(
  engine: OpenGateEngine,
  app: Application | Router,
  routeConfig?: Omit<ExpressOperationalRoutesConfig, "gate">
) {
  ensureObservabilityRoutes(app, engine, routeConfig ? { ...resolveOperationalPaths(engine.config), ...routeConfig } : undefined);
}

function toRequestEnvelope(request: Request, requestIdHeader: string): RequestEnvelope {
  const rawCookieHeader = typeof request.headers.cookie === "string" ? request.headers.cookie : undefined;
  const headers = normalizeHeaders(request.headers);

  return {
    method: request.method,
    url: request.originalUrl ?? request.url,
    path: request.path ?? request.originalUrl ?? request.url,
    ip: request.ip ?? request.socket?.remoteAddress ?? "127.0.0.1",
    requestId: resolveRequestId(headers, requestIdHeader),
    headers,
    cookies: normalizeCookies(parseCookieHeader(rawCookieHeader))
  };
}
