import type { Config } from "./config.js";

export function requiredScopesForPath(config: Config, pathName: string): string[] {
  let matched: Config["routes"][number] | undefined;

  for (const route of config.routes ?? []) {
    if (pathName.startsWith(route.path_prefix)) {
      if (!matched || route.path_prefix.length > matched.path_prefix.length) {
        matched = route;
      }
    }
  }

  return matched?.required_scopes ?? [];
}

export function ipAllowed(config: Config, ip: string | undefined): boolean {
  if (!config.policies?.allowed_ips?.length) {
    return true;
  }

  if (!ip) {
    return false;
  }

  return config.policies.allowed_ips.includes(ip);
}
