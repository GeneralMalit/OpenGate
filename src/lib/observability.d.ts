import type { AuditEvent, OpenGateConfig, OpenGateLogEvent, OpenGateLoggerAdapter, OpenGateMetricsSnapshot, OpenGateStatusSnapshot, OpenGateRequestContext } from "./types.js";
import type { RequestEnvelope } from "./request.js";
export type AuditWriteHooks = {
    onBatchWritten?: (events: AuditEvent[]) => void;
    onBatchFailed?: (events: AuditEvent[], error: unknown) => void;
    onBatchDropped?: (events: AuditEvent[]) => void;
};
export type OpenGateTelemetry = {
    recordRequestFinalized: (context: OpenGateRequestContext, request: Pick<RequestEnvelope, "method" | "path" | "url">, statusCode: number) => OpenGateLogEvent;
    recordAuditBatchWritten: (events: AuditEvent[]) => void;
    recordAuditBatchFailed: (events: AuditEvent[], error: unknown) => void;
    recordAuditBatchDropped: (events: AuditEvent[]) => void;
    recordHealthCheck: (path: string) => void;
    getMetricsSnapshot: () => OpenGateMetricsSnapshot;
    getStatusSnapshot: () => OpenGateStatusSnapshot;
    getRequestIdHeader: () => string;
};
export declare function createOpenGateTelemetry(config: OpenGateConfig, logger?: OpenGateLoggerAdapter | null): OpenGateTelemetry;
export declare function createConsoleLoggerAdapter(): OpenGateLoggerAdapter;
export declare function resolveOperationalPaths(config: OpenGateConfig): {
    healthPath: string;
    readyPath: string;
    metricsPath: string;
    statusPath: string;
};
