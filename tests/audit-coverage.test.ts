import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import {
  createAuditLogger,
  createAuditSink,
  createBufferedAuditLogger,
  createPostgresAuditSink,
  createSqliteAuditSink
} from "../src/lib/audit.js";

const tempDirs: string[] = [];
const mockPg = vi.hoisted(() => {
  const pools: Array<{
    query: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  }> = [];

  class FakePool {
    readonly query = vi.fn(async () => undefined);
    readonly connect = vi.fn(async () => ({
      query: vi.fn(async () => undefined),
      release: vi.fn()
    }));
    readonly end = vi.fn(async () => undefined);

    constructor() {
      pools.push(this);
    }
  }

  return { pools, FakePool };
});

vi.mock("pg", () => ({
  Pool: mockPg.FakePool
}));

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
  mockPg.pools.splice(0, mockPg.pools.length);
});

describe("audit backend coverage", () => {
  it("covers audit logger creation, sink selection, and SQLite schema upgrade", async () => {
    expect(createAuditLogger({
      organizations: [],
      jwt: { issuers: [{ issuer: "issuer", audiences: ["audience"], sharedSecret: "secret" }] },
      apiKeys: { headerName: "x-api-key", clients: [] },
      identityContext: { source: "jwt_claim", claim: "unique_user_id" },
      routePolicies: [],
      rateLimits: {
        timezone: "UTC",
        store: "memory",
        free: { points: 1, duration: "calendar_day" },
        upgraded: { points: 1, duration: "calendar_day" }
      },
      audit: { enabled: false, sqlitePath: ":memory:" }
    })).toBeNull();

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "opengate-audit-"));
    tempDirs.push(tempDir);
    const sqlitePath = path.join(tempDir, "audit.sqlite");

    const existingDb = new Database(sqlitePath);
    existingDb.exec(`
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
    existingDb.close();
    const sqliteSink = createSqliteAuditSink({ sqlitePath });
    await sqliteSink.close();

    const migratedDb = createSqliteAuditSink({ sqlitePath });
    await migratedDb.writeBatch([
      {
        occurredAt: "2026-03-25T00:00:00.000Z",
        requestId: "req-1",
        routePolicyId: "policy-1",
        identityType: "jwt",
        organizationId: "org-1",
        secondaryIdentifier: "user-1",
        method: "GET",
        path: "/api",
        statusCode: 200,
        latencyMs: 4,
        outcome: "allowed",
        blockReason: null,
        jwtClaimSnapshot: { iss: "issuer" }
      }
    ]);
    await migratedDb.close();

    const sink = createAuditSink({
      backend: "sqlite",
      sqlitePath: ":memory:",
      enabled: true
    });
    await sink.writeBatch([]);
    await sink.close();

    const buffered = createAuditLogger({
      organizations: [],
      jwt: { issuers: [{ issuer: "issuer", audiences: ["audience"], sharedSecret: "secret" }] },
      apiKeys: { headerName: "x-api-key", clients: [] },
      identityContext: { source: "jwt_claim", claim: "unique_user_id" },
      routePolicies: [],
      rateLimits: {
        timezone: "UTC",
        store: "memory",
        free: { points: 1, duration: "calendar_day" },
        upgraded: { points: 1, duration: "calendar_day" }
      },
      audit: {
        enabled: true,
        sqlitePath,
        flushIntervalMs: 1,
        batchSize: 1,
        maxQueueSize: 1
      }
    });
    buffered?.log({
      occurredAt: "2026-03-25T00:00:00.000Z",
      requestId: "req-2",
      routePolicyId: "policy-2",
      identityType: "anonymous",
      organizationId: null,
      secondaryIdentifier: null,
      method: "GET",
      path: "/api",
      statusCode: 200,
      latencyMs: 1,
      outcome: "allowed",
      blockReason: null,
      jwtClaimSnapshot: null
    });
    await buffered?.close();
  });

  it("covers the postgres audit sink path with a mocked Pool", async () => {
    const sink = createPostgresAuditSink({
      postgresUrl: "postgres://localhost:5432/opengate",
      postgresTable: "audit_events"
    });

    await sink.writeBatch([]);
    await sink.writeBatch([
      {
        occurredAt: "2026-03-25T00:00:00.000Z",
        requestId: "req-1",
        routePolicyId: "policy-1",
        identityType: "jwt",
        organizationId: "org-1",
        secondaryIdentifier: "user-1",
        method: "GET",
        path: "/api",
        statusCode: 200,
        latencyMs: 4,
        outcome: "allowed",
        blockReason: null,
        jwtClaimSnapshot: { iss: "issuer" }
      }
    ]);
    await sink.close();

    expect(mockPg.pools).toHaveLength(1);
    expect(mockPg.pools[0]?.query).toHaveBeenCalled();
    expect(mockPg.pools[0]?.connect).toHaveBeenCalled();
    expect(mockPg.pools[0]?.end).toHaveBeenCalled();
  });
});
