import { randomUUID } from "node:crypto";

export type RequestHeaderValue = string | string[] | undefined;

export type RequestHeaderMap = Record<string, RequestHeaderValue>;

export type RequestEnvelope = {
  method: string;
  url: string;
  path: string;
  ip: string;
  requestId: string;
  headers: RequestHeaderMap;
  cookies?: Record<string, string>;
};

export function normalizeHeaders(headers: Record<string, unknown> | RequestHeaderMap): RequestHeaderMap {
  const normalized: RequestHeaderMap = {};

  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string" || Array.isArray(value) || value === undefined) {
      normalized[key.toLowerCase()] = value;
      continue;
    }

    normalized[key.toLowerCase()] = String(value);
  }

  return normalized;
}

export function getHeaderValue(headers: RequestHeaderMap, name: string): string | undefined {
  const value = headers[name.toLowerCase()];

  if (Array.isArray(value)) {
    return value[0];
  }

  return typeof value === "string" ? value : undefined;
}

export function resolveRequestId(
  headers: RequestHeaderMap,
  headerName = "x-request-id",
  fallback: string = randomUUID()
): string {
  return getHeaderValue(headers, headerName) ?? fallback;
}

export function parseCookieHeader(cookieHeader: string | undefined): Record<string, string> | undefined {
  if (!cookieHeader) {
    return undefined;
  }

  const cookies: Record<string, string> = {};

  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rawValueParts] = part.split("=");
    const name = rawName?.trim();
    if (!name) {
      continue;
    }

    const rawValue = rawValueParts.join("=");
    cookies[name] = decodeURIComponent(rawValue.trim());
  }

  return Object.keys(cookies).length ? cookies : undefined;
}

export function normalizeCookies(cookies?: Record<string, string | undefined>): Record<string, string> | undefined {
  if (!cookies) {
    return undefined;
  }

  const normalized: Record<string, string> = {};

  for (const [name, value] of Object.entries(cookies)) {
    if (typeof value === "string" && value.length > 0) {
      normalized[name] = value;
    }
  }

  return Object.keys(normalized).length ? normalized : undefined;
}
