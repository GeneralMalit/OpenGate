import type { RequestEnvelope } from "./request.js";
import type { AuditEvent, CreateOpenGateOptions, OpenGateConfig, OpenGateMetricsSnapshot, OpenGateRequestContext, OpenGateStatusSnapshot, ResolvedRoutePolicy } from "./types.js";
export type GateEvaluationResult = {
    allowed: true;
    context: OpenGateRequestContext;
} | {
    allowed: false;
    statusCode: number;
    message: string;
    context: OpenGateRequestContext;
};
export type OpenGateEngine = {
    config: OpenGateConfig;
    evaluateRequest: (request: RequestEnvelope, routePolicy: ResolvedRoutePolicy, startedAt: bigint) => Promise<GateEvaluationResult>;
    buildAuditEvent: (context: OpenGateRequestContext, request: Pick<RequestEnvelope, "method" | "path" | "url">, statusCode: number) => AuditEvent;
    getMetricsSnapshot: () => OpenGateMetricsSnapshot;
    getStatusSnapshot: () => OpenGateStatusSnapshot;
    getRequestIdHeader: () => string;
    recordHealthCheck: (path: string) => void;
    recordAuditEvent: (context: OpenGateRequestContext, request: Pick<RequestEnvelope, "method" | "path" | "url">, statusCode: number) => void;
    close: () => Promise<void>;
};
export declare function createGateEngine(configOrSource?: OpenGateConfig | string | CreateOpenGateOptions): OpenGateEngine;
