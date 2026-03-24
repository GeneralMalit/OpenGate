import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Config } from "./config.js";

export type AuditLogEntry = {
  time: string;
  client_name: string;
  api_key: string;
  method: string;
  path: string;
  status_code: number;
  upstream_ms: number;
  ip: string | null;
};

export type AuditLogger = {
  log: (entry: AuditLogEntry) => void;
  close: () => void;
};

export function createAuditLogger(config: Config): AuditLogger | null {
  if (!config.audit.enabled) {
    return null;
  }

  const dbPath = path.isAbsolute(config.audit.db_path)
    ? config.audit.db_path
    : path.join(process.cwd(), config.audit.db_path);

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      time TEXT NOT NULL,
      client_name TEXT NOT NULL,
      api_key TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      upstream_ms INTEGER NOT NULL,
      ip TEXT
    );
  `);

  const insert = db.prepare(`
    INSERT INTO audit_logs (
      time, client_name, api_key, method, path, status_code, upstream_ms, ip
    ) VALUES (
      @time, @client_name, @api_key, @method, @path, @status_code, @upstream_ms, @ip
    );
  `);

  return {
    log(entry: AuditLogEntry) {
      insert.run(entry);
    },
    close() {
      db.close();
    }
  };
}
