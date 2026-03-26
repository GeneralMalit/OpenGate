import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStarterBundle, runCli, validateConfigDetailed } from "../src/index.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("starter generation", () => {
  it("creates a mixed starter bundle with the expected route mode", () => {
    const bundle = createStarterBundle("mixed");

    expect(bundle.config.routePolicies[0]?.accessMode).toBe("authenticated");
    expect(bundle.files["server.ts"]).toContain('accessMode: "authenticated"');
    expect(bundle.files["README.md"]).toContain("OpenGate Starter");
    expect(bundle.files["DEMO-CREDENTIALS.md"]).toContain("OpenGate Demo Credentials");
    expect(bundle.files["data/audit-sample.json"]).toContain("starter-mixed");
  });

  it("creates the website starter template with login guidance", () => {
    const bundle = createStarterBundle({ template: "website" });

    expect(bundle.template).toBe("website");
    expect(bundle.config.routePolicies[0]?.accessMode).toBe("public");
    expect(bundle.files["server.ts"]).toContain("Website starter");
    expect(bundle.files["server.ts"]).toContain("@opengate/fastify");
    expect(bundle.files["README.md"]).toContain("HttpOnly");
    expect(bundle.files["DEMO-CREDENTIALS.md"]).toContain("ava / demo-pass-1");
  });

  it("creates the api and partner starter templates with the right route modes", () => {
    const apiBundle = createStarterBundle({ template: "api" });
    const partnerBundle = createStarterBundle({ template: "partner" });

    expect(apiBundle.template).toBe("api");
    expect(apiBundle.config.routePolicies[0]?.accessMode).toBe("jwt");
    expect(apiBundle.files["README.md"]).toContain("JWT access");

    expect(partnerBundle.template).toBe("partner");
    expect(partnerBundle.config.routePolicies[0]?.accessMode).toBe("api_key");
    expect(partnerBundle.files["README.md"]).toContain("API-key access");
    expect(partnerBundle.files["DEMO-CREDENTIALS.md"]).toContain("raw API key");
  });
});

describe("cli commands", () => {
  it("creates a starter project with config, server, credentials, and sample audit files", async () => {
    const cwd = makeTempDir();
    const result = await runCli(["init", "--route", "jwt"], cwd);

    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(path.join(cwd, "opengate.config.json"))).toBe(true);
    expect(fs.existsSync(path.join(cwd, "server.ts"))).toBe(true);
    expect(fs.existsSync(path.join(cwd, "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(cwd, "DEMO-CREDENTIALS.md"))).toBe(true);
    expect(fs.existsSync(path.join(cwd, "data", "audit-sample.json"))).toBe(true);

    const config = JSON.parse(fs.readFileSync(path.join(cwd, "opengate.config.json"), "utf8")) as {
      routePolicies: Array<{ accessMode: string }>;
    };

    expect(config.routePolicies[0]?.accessMode).toBe("jwt");
  });

  it("creates a template starter project when requested", async () => {
    const cwd = makeTempDir();
    const result = await runCli(["init", "--template", "website"], cwd);

    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(path.join(cwd, "README.md"))).toBe(true);
    expect(fs.readFileSync(path.join(cwd, "server.ts"), "utf8")).toContain("Website starter");
    expect(fs.readFileSync(path.join(cwd, "opengate.config.json"), "utf8")).toContain('"public"');
  });

  it("validates the generated starter config", async () => {
    const cwd = makeTempDir();
    await runCli(["init", "--route", "public"], cwd);

    const result = await runCli(["validate", "--file", "opengate.config.json"], cwd);
    expect(result.exitCode).toBe(0);
  });

  it("migrates legacy keyHash and sharedSecret shapes into versioned config", async () => {
    const cwd = makeTempDir();
    const legacyConfig = {
      organizations: [{ id: "acme", name: "Acme", enabled: true }],
      jwt: {
        issuers: [
          {
            issuer: "legacy-issuer",
            audiences: ["legacy-audience"],
            sharedSecret: "legacy-secret"
          }
        ]
      },
      apiKeys: {
        headerName: "x-api-key",
        clients: [
          {
            id: "client-1",
            name: "Legacy Client",
            organizationId: "acme",
            userId: "user-1",
            keyHash: "legacy-hash"
          }
        ]
      },
      identityContext: { source: "jwt_claim", claim: "unique_user_id", required: true, globalUniqueness: "global" },
      routePolicies: [{ id: "api", pathPrefix: "/api", accessMode: "public", requiredScopes: [], enabled: true }],
      rateLimits: {
        timezone: "UTC",
        store: "memory",
        free: { points: 10, duration: "calendar_day" },
        upgraded: { points: 1000, duration: "calendar_day" }
      },
      audit: { enabled: true, sqlitePath: "./data/opengate.db", jwtClaimSnapshot: ["iss", "aud", "sub", "org_id", "unique_user_id"] },
      behavior: { onMissingSecondaryIdentifier: "reject", onCredentialMismatch: "deny", onDisabledOrganization: "block" }
    };

    fs.writeFileSync(path.join(cwd, "legacy.json"), JSON.stringify(legacyConfig, null, 2));
    const result = await runCli(["migrate", "--file", "legacy.json", "--out", "migrated.json"], cwd);
    expect(result.exitCode).toBe(0);

    const migrated = JSON.parse(fs.readFileSync(path.join(cwd, "migrated.json"), "utf8")) as {
      jwt: { issuers: Array<{ verificationMode: string }> };
      apiKeys: { clients: Array<{ keyVersions?: Array<{ keyHash: string }> }> };
    };

    expect(migrated.jwt.issuers[0]?.verificationMode).toBe("shared_secret");
    expect(migrated.apiKeys.clients[0]?.keyVersions).toHaveLength(1);
  });

  it("reports plain-language validation errors for unsupported audit claims", () => {
    const report = validateConfigDetailed({
      organizations: [{ id: "acme", name: "Acme", enabled: true }],
      jwt: {
        issuers: [
          {
            issuer: "issuer",
            audiences: ["audience"],
            sharedSecret: "secret"
          }
        ]
      },
      apiKeys: { headerName: "x-api-key", clients: [] },
      identityContext: { source: "jwt_claim", claim: "unique_user_id", required: true, globalUniqueness: "global" },
      routePolicies: [{ id: "api", pathPrefix: "/api", accessMode: "public", requiredScopes: [], enabled: true }],
      rateLimits: {
        timezone: "UTC",
        store: "memory",
        free: { points: 10, duration: "calendar_day" },
        upgraded: { points: 1000, duration: "calendar_day" }
      },
      audit: { enabled: true, sqlitePath: "./data/opengate.db", jwtClaimSnapshot: ["iss", "email"] },
      behavior: { onMissingSecondaryIdentifier: "reject", onCredentialMismatch: "deny", onDisabledOrganization: "block" }
    });

    expect(report.ok).toBe(false);
    if (!report.ok) {
      expect(report.issues[0]?.path).toBe("audit.jwtClaimSnapshot");
      expect(report.issues[0]?.message).toContain("Unsupported claim");
    }
  });

  it("covers help, unknown commands, and control-plane CLI branches", async () => {
    const cwd = makeTempDir();
    const config = {
      organizations: [{ id: "acme", name: "Acme", enabled: true }],
      users: [{ id: "user-1", name: "User One", organizationId: "acme", enabled: true }],
      jwt: {
        issuers: [
          {
            issuer: "issuer",
            audiences: ["audience"],
            sharedSecret: "secret"
          }
        ]
      },
      apiKeys: {
        headerName: "x-api-key",
        clients: [
          {
            id: "client-1",
            name: "Client One",
            organizationId: "acme",
            userId: "user-1",
            keyHash: "legacy-hash"
          }
        ]
      },
      identityContext: { source: "jwt_claim", claim: "unique_user_id", required: true, globalUniqueness: "global" },
      routePolicies: [
        { id: "api", pathPrefix: "/api", accessMode: "public", requiredScopes: [], enabled: true }
      ],
      rateLimits: {
        timezone: "UTC",
        store: "memory",
        free: { points: 10, duration: "calendar_day" },
        upgraded: { points: 1000, duration: "calendar_day" }
      },
      audit: { enabled: true, sqlitePath: "./data/opengate.db", jwtClaimSnapshot: ["iss", "aud", "sub", "org_id", "unique_user_id"] },
      behavior: { onMissingSecondaryIdentifier: "reject", onCredentialMismatch: "deny", onDisabledOrganization: "block" }
    };

    fs.writeFileSync(path.join(cwd, "opengate.config.json"), JSON.stringify(config, null, 2));

    expect((await runCli([], cwd)).exitCode).toBe(0);
    expect((await runCli(["help"], cwd)).exitCode).toBe(0);
    expect((await runCli(["unknown-command"], cwd)).exitCode).toBe(1);
    expect((await runCli(["init", "--route", "bogus"], cwd)).exitCode).toBe(1);
    expect((await runCli(["control"], cwd)).exitCode).toBe(0);

    expect((await runCli(["control", "list", "organizations"], cwd)).exitCode).toBe(0);
    expect((await runCli(["control", "list", "users"], cwd)).exitCode).toBe(0);
    expect((await runCli(["control", "list", "api-keys"], cwd)).exitCode).toBe(0);
    expect((await runCli(["control", "list", "route-policies"], cwd)).exitCode).toBe(0);
    expect((await runCli(["control", "get", "organizations", "acme"], cwd)).exitCode).toBe(0);
    expect((await runCli(["control", "get", "users", "user-1"], cwd)).exitCode).toBe(0);
    expect((await runCli(["control", "get", "api-keys", "client-1"], cwd)).exitCode).toBe(0);
    expect((await runCli(["control", "get", "route-policies", "api"], cwd)).exitCode).toBe(0);

    expect((await runCli([
      "control",
      "issue",
      "api-key",
      "--file",
      "opengate.config.json",
      "--name",
      "CLI Client",
      "--organization",
      "acme",
      "--user",
      "user-1",
      "--client-id",
      "cli-client",
      "--raw-key",
      "cli-client-secret"
    ], cwd)).exitCode).toBe(0);

    expect((await runCli([
      "control",
      "rotate",
      "api-key",
      "cli-client",
      "--file",
      "opengate.config.json",
      "--raw-key",
      "cli-client-secret-v2"
    ], cwd)).exitCode).toBe(0);

    expect((await runCli([
      "control",
      "disable",
      "api-key",
      "cli-client",
      "--file",
      "opengate.config.json",
      "--version-id",
      "cli-client-primary"
    ], cwd)).exitCode).toBe(0);

    expect((await runCli([
      "control",
      "enable",
      "organization",
      "acme",
      "--file",
      "opengate.config.json"
    ], cwd)).exitCode).toBe(0);

    expect((await runCli([
      "control",
      "simulate",
      "--file",
      "opengate.config.json",
      "--method",
      "GET",
      "--path",
      "/api"
    ], cwd)).exitCode).toBe(0);

    expect((await runCli([
      "control",
      "revoke",
      "api-key",
      "cli-client",
      "--file",
      "opengate.config.json"
    ], cwd)).exitCode).toBe(0);
  });
});

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opengate-cli-"));
  tempDirs.push(dir);
  return dir;
}


