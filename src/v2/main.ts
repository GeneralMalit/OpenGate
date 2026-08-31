#!/usr/bin/env node

import { runV2Cli, type ServeOptions } from "./cli.js";
import { validateRuntimeConfig } from "./config.js";
import { closeDatabase, openDatabase, SqliteAdminStore } from "./data/index.js";
import { defaultPasswordHasher } from "./domain/index.js";
import { createOpenGateV2 } from "./server.js";

function configFromServe(options: ServeOptions) {
  return validateRuntimeConfig({
    databasePath: options.databaseUrl,
    keyPepper: options.keyPepper,
    sessionSecret: options.sessionSecret,
    bindHost: options.host,
    port: options.port,
    publicBaseUrl: options.publicBaseUrl ?? `http://${options.host}:${options.port}`,
    trustedProxyHops: options.trustedProxyHops,
    environment: process.env.NODE_ENV ?? "development"
  });
}

const result = await runV2Cli(process.argv.slice(2), {
  runtime: {
    async bootstrapAdmin(input) {
      const databasePath = process.env.OPENGATE_DATABASE_URL ?? "./data/opengate.sqlite";
      const db = openDatabase(databasePath);
      try {
        const store = new SqliteAdminStore(db);
        if (store.countAdmins() > 0) throw new Error("An administrator already exists; use the setup page to manage administrators.");
        return store.createAdmin({ email: input.email, passwordHash: await defaultPasswordHasher.hash(input.password) });
      } finally {
        closeDatabase(db);
      }
    },
    async migrate({ databaseUrl }) {
      const db = openDatabase(databaseUrl);
      closeDatabase(db);
    },
    async serve(options) {
      const runtime = await createOpenGateV2({ config: configFromServe(options) });
      await runtime.app.listen({ host: runtime.config.bindHost, port: runtime.config.port });
      process.stdout.write(`OpenGate v2 listening on ${runtime.config.publicBaseUrl}\n`);
    }
  }
});

process.exitCode = result.exitCode;
