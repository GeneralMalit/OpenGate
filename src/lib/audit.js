import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { Pool } from "pg";
export function createAuditLogger(config, hooks) {
    if (!config.audit.enabled) {
        return null;
    }
    const sink = createAuditSink(config.audit);
    return createBufferedAuditLogger(config.audit, sink, hooks);
}
export function createBufferedAuditLogger(auditConfig, sink, hooks) {
    const queue = [];
    let flushTimer = null;
    let flushing = null;
    let closed = false;
    const maxQueueSize = auditConfig.maxQueueSize ?? 1000;
    const batchSize = Math.max(1, auditConfig.batchSize ?? 50);
    const flushIntervalMs = Math.max(1, auditConfig.flushIntervalMs ?? 25);
    return {
        log(event) {
            if (closed) {
                return;
            }
            if (queue.length >= maxQueueSize) {
                const dropped = queue.shift();
                if (dropped) {
                    hooks?.onBatchDropped?.([dropped]);
                }
            }
            queue.push(event);
            scheduleFlush();
        },
        async close() {
            closed = true;
            if (flushTimer) {
                clearTimeout(flushTimer);
                flushTimer = null;
            }
            await flushQueue(true);
            await sink.close();
        }
    };
    function scheduleFlush() {
        if (flushing || flushTimer || closed) {
            return;
        }
        flushTimer = setTimeout(() => {
            flushTimer = null;
            void flushQueue(false);
        }, flushIntervalMs);
        flushTimer.unref?.();
    }
    async function flushQueue(retryOnFailure) {
        if (flushing) {
            await flushing;
            return;
        }
        flushing = (async () => {
            while (queue.length > 0) {
                const batch = queue.splice(0, batchSize);
                try {
                    await sink.writeBatch(batch);
                    hooks?.onBatchWritten?.(batch);
                }
                catch (error) {
                    queue.unshift(...batch);
                    hooks?.onBatchFailed?.(batch, error);
                    console.warn("OpenGate audit write failed; will retry on the next flush.", error);
                    if (!retryOnFailure) {
                        await delay(flushIntervalMs);
                        break;
                    }
                    await delay(flushIntervalMs);
                }
            }
        })();
        try {
            await flushing;
        }
        finally {
            flushing = null;
            if (queue.length > 0 && !closed) {
                scheduleFlush();
            }
        }
    }
}
export function createAuditSink(auditConfig) {
    switch (auditConfig.backend ?? "sqlite") {
        case "postgres":
            return createPostgresAuditSink(auditConfig);
        case "sqlite":
        default:
            return createSqliteAuditSink(auditConfig);
    }
}
export function createSqliteAuditSink(auditConfig) {
    const sqlitePath = auditConfig.sqlitePath;
    if (sqlitePath !== ":memory:") {
        fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    }
    const db = new Database(sqlitePath);
    db.pragma("journal_mode = WAL");
    db.exec(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at TEXT NOT NULL,
      request_id TEXT NOT NULL,
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
    const columns = db.prepare("PRAGMA table_info(audit_events)").all();
    if (!columns.some((column) => column.name === "request_id")) {
        db.exec("ALTER TABLE audit_events ADD COLUMN request_id TEXT");
    }
    const insert = db.prepare(`
    INSERT INTO audit_events (
      occurred_at,
      request_id,
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
      @requestId,
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
    const transaction = db.transaction((events) => {
        for (const event of events) {
            insert.run({
                ...event,
                jwtClaimSnapshot: event.jwtClaimSnapshot ? JSON.stringify(event.jwtClaimSnapshot) : null
            });
        }
    });
    return {
        async writeBatch(events) {
            if (!events.length) {
                return;
            }
            transaction(events);
        },
        async close() {
            db.close();
        }
    };
}
export function createPostgresAuditSink(auditConfig) {
    if (!auditConfig.postgresUrl) {
        throw new Error("Postgres audit backend requires postgresUrl.");
    }
    const tableName = auditConfig.postgresTable ?? "audit_events";
    const pool = new Pool({ connectionString: auditConfig.postgresUrl });
    const init = pool.query(`
    CREATE TABLE IF NOT EXISTS ${quoteIdentifier(tableName)} (
      id BIGSERIAL PRIMARY KEY,
      occurred_at TEXT NOT NULL,
      route_policy_id TEXT NOT NULL,
      identity_type TEXT NOT NULL,
      organization_id TEXT,
      secondary_identifier TEXT,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      latency_ms DOUBLE PRECISION NOT NULL,
      outcome TEXT NOT NULL,
      block_reason TEXT,
      jwt_claim_snapshot JSONB
    );
  `);
    return {
        async writeBatch(events) {
            if (!events.length) {
                return;
            }
            await init;
            const client = await pool.connect();
            try {
                await client.query("BEGIN");
                for (const event of events) {
                    await client.query(`INSERT INTO ${quoteIdentifier(tableName)} (
              occurred_at,
              request_id,
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
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [
                        event.occurredAt,
                        event.requestId,
                        event.routePolicyId,
                        event.identityType,
                        event.organizationId,
                        event.secondaryIdentifier,
                        event.method,
                        event.path,
                        event.statusCode,
                        event.latencyMs,
                        event.outcome,
                        event.blockReason,
                        event.jwtClaimSnapshot ? JSON.stringify(event.jwtClaimSnapshot) : null
                    ]);
                }
                await client.query("COMMIT");
            }
            catch (error) {
                await client.query("ROLLBACK").catch(() => undefined);
                throw error;
            }
            finally {
                client.release();
            }
        },
        async close() {
            await init.catch(() => undefined);
            await pool.end();
        }
    };
}
function quoteIdentifier(identifier) {
    return `"${identifier.replace(/"/g, '""')}"`;
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
