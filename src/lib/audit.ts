import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { AuditEvent, OpenGateConfig } from "./types.js";

export type AuditLogger = {
  log: (event: AuditEvent) => void;
  close: () => void;
};

export function createAuditLogger(config: OpenGateConfig): AuditLogger | null {
  if (!config.audit.enabled) {
    return null;
  }

  const sqlitePath = config.audit.sqlitePath;

  if (sqlitePath !== ":memory:") {
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  }

  const db = new Database(sqlitePath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at TEXT NOT NULL,
      route_policy_id TEXT NOT NULL,
      identity_type TEXT NOT NULL,
      organization_id TEXT,
      secondary_identifier TEXT,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL,
      outcome TEXT NOT NULL,
      block_reason TEXT,
      jwt_claim_snapshot TEXT
    );
  `);

  const insert = db.prepare(`
    INSERT INTO audit_events (
      occurred_at,
      route_policy_id,
      identity_type,
      organization_id,
      secondary_identifier,
      method,
      path,
      status_code,
      latency_ms,
      outcome,
      block_reason,
      jwt_claim_snapshot
    ) VALUES (
      @occurredAt,
      @routePolicyId,
      @identityType,
      @organizationId,
      @secondaryIdentifier,
      @method,
      @path,
      @statusCode,
      @latencyMs,
      @outcome,
      @blockReason,
      @jwtClaimSnapshot
    );
  `);

  return {
    log(event) {
      insert.run({
        ...event,
        jwtClaimSnapshot: event.jwtClaimSnapshot ? JSON.stringify(event.jwtClaimSnapshot) : null
      });
    },
    close() {
      db.close();
    }
  };
}
