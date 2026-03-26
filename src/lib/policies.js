export function resolveRoutePolicy(config, routePath, overrides) {
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
function findLongestPrefixPolicy(config, pathName) {
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
