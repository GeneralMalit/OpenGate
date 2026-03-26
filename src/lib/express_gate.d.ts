import type { Application, Router } from "express";
import type { CreateOpenGateOptions, ExpressOpenGate, ExpressRegisterProtectedRouteConfig, OpenGateConfig } from "./types.js";
export declare function createExpressOpenGate(configOrSource?: OpenGateConfig | string | CreateOpenGateOptions): ExpressOpenGate;
export declare function registerProtectedRoute(app: Application | Router, routeConfig: ExpressRegisterProtectedRouteConfig): void;
