import type { OpenGateConfig, RegisterProtectedRouteConfig, ResolvedRoutePolicy } from "./types.js";

export function resolveRoutePolicy(
  config: OpenGateConfig,
  routePath: string,
  overrides?: Pick<RegisterProtectedRouteConfig, "policyId" | "accessMode" | "requiredScopes" | "enabled">
): ResolvedRoutePolicy {
  const fromConfig = overrides?.policyId
    ? config.routePolicies.find((item) => item.id === overrides.policyId)
    : findLongestPrefixPolicy(config, routePath);

  if (!fromConfig && !overrides?.accessMode) {
    throw new Error(`No route policy matched path "${routePath}" and no explicit access mode override was provided.`);
  }

  return {
    id: overrides?.policyId ?? fromConfig?.id ?? `implicit:${routePath}`,
    pathPrefix: fromConfig?.pathPrefix ?? routePath,
    accessMode: overrides?.accessMode ?? fromConfig?.accessMode ?? "public",
    requiredScopes: overrides?.requiredScopes ?? fromConfig?.requiredScopes ?? [],
    enabled: overrides?.enabled ?? fromConfig?.enabled ?? true
  };
}

function findLongestPrefixPolicy(config: OpenGateConfig, pathName: string) {
  let match = config.routePolicies.find((item) => pathName.startsWith(item.pathPrefix));

  for (const policy of config.routePolicies) {
    if (!policy.enabled) {
      continue;
    }

    if (!pathName.startsWith(policy.pathPrefix)) {
      continue;
    }

    if (!match || policy.pathPrefix.length > match.pathPrefix.length) {
      match = policy;
    }
  }

  return match;
}
