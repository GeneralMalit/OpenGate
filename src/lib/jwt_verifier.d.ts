import type { JwtIssuerConfig, OpenGateConfig } from "./types.js";
type JwtVerificationSuccess = {
    ok: true;
    payload: Record<string, unknown>;
    issuerConfig: JwtIssuerConfig;
};
type JwtVerificationFailure = {
    ok: false;
    statusCode: number;
    message: string;
    blockReason: string;
};
export type JwtVerificationResult = JwtVerificationSuccess | JwtVerificationFailure;
type JwtVerifier = {
    verify: (token: string) => Promise<JwtVerificationResult>;
};
export declare function getJwtVerifier(config: OpenGateConfig): JwtVerifier;
export {};
