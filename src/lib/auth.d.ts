import type { ApiClientConfig, ApiKeyVersionConfig, OpenGateConfig, RequestIdentity, ResolvedRoutePolicy } from "./types.js";
import type { RequestEnvelope } from "./request.js";
export type AuthorizationDecision = {
    allowed: true;
    identity: RequestIdentity;
    jwtClaimSnapshot: Record<string, unknown> | null;
} | {
    allowed: false;
    identity: RequestIdentity;
    statusCode: number;
    message: string;
    blockReason: string;
    jwtClaimSnapshot: Record<string, unknown> | null;
};
export declare function authorizeRequest(config: OpenGateConfig, policy: ResolvedRoutePolicy, request: RequestEnvelope): Promise<AuthorizationDecision>;
export declare function hashApiKey(rawKey: string): string;
export declare function createApiClientConfig(input: Omit<ApiClientConfig, "keyHash"> & {
    rawKey: string;
}): ApiClientConfig;
export declare function createApiKeyVersionConfig(input: Omit<ApiKeyVersionConfig, "keyHash"> & {
    rawKey: string;
}): ApiKeyVersionConfig;
