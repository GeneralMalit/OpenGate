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
export declare function normalizeHeaders(headers: Record<string, unknown> | RequestHeaderMap): RequestHeaderMap;
export declare function getHeaderValue(headers: RequestHeaderMap, name: string): string | undefined;
export declare function resolveRequestId(headers: RequestHeaderMap, headerName?: string, fallback?: string): string;
export declare function parseCookieHeader(cookieHeader: string | undefined): Record<string, string> | undefined;
export declare function normalizeCookies(cookies?: Record<string, string | undefined>): Record<string, string> | undefined;
