import { randomUUID } from "node:crypto";
export function normalizeHeaders(headers) {
    const normalized = {};
    for (const [key, value] of Object.entries(headers)) {
        if (typeof value === "string" || Array.isArray(value) || value === undefined) {
            normalized[key.toLowerCase()] = value;
            continue;
        }
        normalized[key.toLowerCase()] = String(value);
    }
    return normalized;
}
export function getHeaderValue(headers, name) {
    const value = headers[name.toLowerCase()];
    if (Array.isArray(value)) {
        return value[0];
    }
    return typeof value === "string" ? value : undefined;
}
export function resolveRequestId(headers, headerName = "x-request-id", fallback = randomUUID()) {
    return getHeaderValue(headers, headerName) ?? fallback;
}
export function parseCookieHeader(cookieHeader) {
    if (!cookieHeader) {
        return undefined;
    }
    const cookies = {};
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
export function normalizeCookies(cookies) {
    if (!cookies) {
        return undefined;
    }
    const normalized = {};
    for (const [name, value] of Object.entries(cookies)) {
        if (typeof value === "string" && value.length > 0) {
            normalized[name] = value;
        }
    }
    return Object.keys(normalized).length ? normalized : undefined;
}
