import type { OpenGateConfig, RegisterProtectedRouteConfig, ResolvedRoutePolicy } from "./types.js";
export declare function resolveRoutePolicy(config: OpenGateConfig, routePath: string, overrides?: Pick<RegisterProtectedRouteConfig, "policyId" | "accessMode" | "requiredScopes" | "enabled">): ResolvedRoutePolicy;
