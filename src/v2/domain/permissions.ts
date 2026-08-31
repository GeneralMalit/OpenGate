import type { RolePermission } from "./types.js";

const METHOD_PATTERN = /^[A-Z][A-Z0-9$._-]*$/;

export function normalizeMethod(method: string): string {
  const normalized = method.trim().toUpperCase();
  if (!METHOD_PATTERN.test(normalized) && normalized !== "*") throw new Error(`Invalid HTTP method: ${method}`);
  return normalized;
}

/** Query strings and fragments are deliberately excluded from authorization. */
export function normalizePath(path: string): string {
  if (typeof path !== "string" || !path.startsWith("/") || /[\u0000-\u001f\u007f]/.test(path)) throw new Error("Invalid request path.");
  const queryIndex = path.search(/[?#]/);
  return queryIndex < 0 ? path : path.slice(0, queryIndex);
}

export function validatePathPattern(pattern: string): string {
  const normalized = normalizePath(pattern);
  if (normalized.includes("\\")) throw new Error("Path patterns cannot contain backslashes.");
  return normalized;
}

/**
 * Anchored, deliberately tiny glob matcher. `*` matches zero or more characters;
 * there is no regex evaluation and the match always covers the whole path.
 */
export function matchesPathPattern(path: string, pattern: string): boolean {
  const value = normalizePath(path);
  const rule = validatePathPattern(pattern);
  let v = 0;
  let p = 0;
  let star = -1;
  let retry = 0;
  while (v < value.length) {
    if (p < rule.length && rule[p] !== "*" && rule[p] === value[v]) {
      p++;
      v++;
    } else if (p < rule.length && rule[p] === "*") {
      star = p++;
      retry = v;
    } else if (star >= 0) {
      p = star + 1;
      v = ++retry;
    } else {
      return false;
    }
  }
  while (p < rule.length && rule[p] === "*") p++;
  return p === rule.length;
}

export function permissionMatches(permission: RolePermission, apiId: string, method: string, path: string): boolean {
  const apiMatches = permission.apiId == null || permission.apiId === apiId;
  const methodRule = normalizeMethod(permission.method);
  return apiMatches && (methodRule === "*" || methodRule === normalizeMethod(method)) && matchesPathPattern(path, permission.pathPattern);
}

export function isPermitted(permissions: readonly RolePermission[], apiId: string, method: string, path: string): boolean {
  return permissions.some((permission) => permissionMatches(permission, apiId, method, path));
}
