import type { AuditConfig, AuditEvent, OpenGateConfig } from "./types.js";
import type { AuditWriteHooks } from "./observability.js";
export type AuditSink = {
    writeBatch: (events: AuditEvent[]) => Promise<void>;
    close: () => Promise<void>;
};
export type AuditLogger = {
    log: (event: AuditEvent) => void;
    close: () => Promise<void>;
};
export declare function createAuditLogger(config: OpenGateConfig, hooks?: AuditWriteHooks): AuditLogger | null;
export declare function createBufferedAuditLogger(auditConfig: AuditConfig, sink: AuditSink, hooks?: AuditWriteHooks): AuditLogger;
export declare function createAuditSink(auditConfig: AuditConfig): AuditSink;
export declare function createSqliteAuditSink(auditConfig: Pick<AuditConfig, "sqlitePath">): AuditSink;
export declare function createPostgresAuditSink(auditConfig: Pick<AuditConfig, "postgresUrl" | "postgresTable">): AuditSink;
