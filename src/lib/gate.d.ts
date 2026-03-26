import type { FastifyInstance } from "fastify";
import type { CreateOpenGateOptions, FastifyRegisterProtectedRouteConfig, OpenGate, OpenGateConfig } from "./types.js";
export declare function createOpenGate(configOrSource?: OpenGateConfig | string | CreateOpenGateOptions): OpenGate;
export declare function registerProtectedRoute(app: FastifyInstance, routeConfig: FastifyRegisterProtectedRouteConfig): void;
