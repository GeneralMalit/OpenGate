import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createControlPlane, createOpenGate, registerControlPlaneRoutes, runCli } from "../src/index.js";
import { createTestConfig, signTestJwt } from "./helpers.js";

const disposers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (disposers.length > 0) {
    const dispose = disposers.pop();
    await dispose?.();
  }
});

function makeControlPlaneConfig() {
  return createTestConfig({
    users: [
      { id: "user-1", name: "User One", organizationId: "org-active", enabled: true },
      { id: "user-2", name: "User Two", organizationId: "org-active", enabled: true },
      { id: "user-disabled", name: "Disabled User", organizationId: "org-disabled", enabled: false }
    ],
    audit: {
      enabled: false,
      sqlitePath: ":memory:"
    }
  });
}

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opengate-phase6-"));
  disposers.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("phase 6 control plane", () => {
  it("manages organizations, users, keys, policies, and config persistence", async () => {
    const tempDir = makeTempDir();
    const configPath = path.join(tempDir, "opengate.config.json");
    fs.writeFileSync(configPath, JSON.stringify(makeControlPlaneConfig(), null, 2));

    const events: Array<{ action: string; resource: string; targetId: string | null }> = [];
    const controlPlane = createControlPlane({
      configPath,
      logger: {
        emit(event) {
          events.push({ action: event.action, resource: event.resource, targetId: event.targetId });
        }
      }
    });

    expect(controlPlane.listOrganizations()).toHaveLength(2);
    expect(controlPlane.getUser("user-1")).toMatchObject({
      id: "user-1",
      organizationId: "org-active"
    });

    controlPlane.upsertOrganization({
      id: "org-new",
      name: "New Organization",
      enabled: true
    });

    controlPlane.upsertUser({
      id: "user-new",
      name: "New User",
      organizationId: "org-new",
      enabled: true
    });

    const issued = controlPlane.issueApiKey({
      clientId: "client-new",
      name: "New Client",
      organizationId: "org-new",
      userId: "user-new",
      rawKey: "client-new-raw-key",
      scopes: ["time:read"],
      enabled: true
    });

    const versionId = issued.after?.keyVersions?.[0]?.id;
    expect(versionId).toBeDefined();

    controlPlane.rotateApiKey({
      clientId: "client-new",
      rawKey: "client-new-raw-key-v2",
      scopes: ["time:read", "admin:read"],
      enabled: true
    });

    controlPlane.revokeApiKey({
      clientId: "client-new",
      versionId
    });

    controlPlane.setApiKeyEnabled("client-new", false, versionId);
    controlPlane.upsertRoutePolicy({
      id: "admin-api",
      pathPrefix: "/admin",
      accessMode: "authenticated",
      requiredScopes: [],
      enabled: true
    });

    await Promise.resolve();

    const exported = JSON.parse(controlPlane.exportConfig()) as ReturnType<typeof makeControlPlaneConfig>;
    expect(exported.organizations.some((organization) => organization.id === "org-new")).toBe(true);
    expect(exported.users?.some((user) => user.id === "user-new")).toBe(true);
    expect(exported.apiKeys.clients.some((client) => client.id === "client-new")).toBe(true);
    expect(exported.routePolicies.some((policy) => policy.id === "admin-api")).toBe(true);

    const persisted = JSON.parse(fs.readFileSync(configPath, "utf8")) as typeof exported;
    expect(persisted.apiKeys.clients.some((client) => client.id === "client-new")).toBe(true);

    controlPlane.replaceConfig(exported);
    expect(controlPlane.getApiKey("client-new")).toMatchObject({
      id: "client-new",
      organizationId: "org-new"
    });

    expect(events.some((event) => event.action === "issue" && event.resource === "apiKeys")).toBe(true);
    expect(events.some((event) => event.action === "rotate" && event.resource === "apiKeys")).toBe(true);
    expect(events.some((event) => event.action === "revoke" && event.resource === "apiKeys")).toBe(true);
    expect(events.some((event) => event.action === "upsert" && event.resource === "users")).toBe(true);
  });

  it("simulates decisions against the current policy config", async () => {
    const controlPlane = createControlPlane({ config: makeControlPlaneConfig() });

    const denied = await controlPlane.simulateRequest({
      method: "GET",
      path: "/jwt"
    });

    expect(denied.allowed).toBe(false);
    expect(denied.routePolicyId).toBe("jwt-api");
    expect(denied.statusCode).toBe(401);
    expect(denied.message).toBe("unauthorized");
    expect(denied.blockReason).toBe("jwt_required");

    const allowed = await controlPlane.simulateRequest({
      method: "GET",
      path: "/api"
    });

    expect(allowed.allowed).toBe(true);
    expect(allowed.routePolicyId).toBe("public-api");
  });

  it("protects the admin API with the existing authentication model", async () => {
    const config = makeControlPlaneConfig();
    const gate = createOpenGate(config);
    const controlPlane = createControlPlane({ config });
    const app = Fastify({ logger: false });

    gate.registerProtectedRoute(app, {
      path: "/api",
      method: "GET",
      handler: async () => ({ ok: true })
    });

    registerControlPlaneRoutes(app, gate, controlPlane, { basePath: "/admin" });
    disposers.push(async () => {
      await app.close();
      await gate.close();
    });

    const token = await signTestJwt({ unique_user_id: "user-1", sub: "user-1" });

    const listUsers = await app.inject({
      method: "GET",
      url: "/admin/users",
      headers: {
        authorization: `Bearer ${token}`
      }
    });

    expect(listUsers.statusCode).toBe(200);
    expect(listUsers.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "user-1" })
    ]));

    const issueResponse = await app.inject({
      method: "POST",
      url: "/admin/api-keys/issue",
      headers: {
        authorization: `Bearer ${token}`
      },
      payload: {
        clientId: "api-client-admin",
        name: "Admin API Client",
        organizationId: "org-active",
        userId: "user-1",
        rawKey: "admin-api-client-key",
        scopes: ["time:read"]
      }
    });

    expect(issueResponse.statusCode).toBe(200);
    expect(issueResponse.json()).toMatchObject({
      rawKey: "admin-api-client-key",
      after: {
        id: "api-client-admin"
      }
    });

    const exportResponse = await app.inject({
      method: "GET",
      url: "/admin/export",
      headers: {
        authorization: `Bearer ${token}`
      }
    });

    expect(exportResponse.statusCode).toBe(200);
    expect(exportResponse.json()).toMatchObject({
      organizations: expect.arrayContaining([
        expect.objectContaining({ id: "org-active" })
      ])
    });
  });

  it("supports CLI control workflows", async () => {
    const tempDir = makeTempDir();
    const configPath = path.join(tempDir, "opengate.config.json");
    fs.writeFileSync(configPath, JSON.stringify(makeControlPlaneConfig(), null, 2));

    const issueResult = await runCli([
      "control",
      "issue",
      "api-key",
      "--file",
      "opengate.config.json",
      "--name",
      "CLI Client",
      "--organization",
      "org-active",
      "--user",
      "user-1",
      "--client-id",
      "cli-client",
      "--raw-key",
      "cli-client-secret",
      "--scopes",
      "time:read"
    ], tempDir);

    expect(issueResult.exitCode).toBe(0);

    const persisted = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      apiKeys: { clients: Array<{ id: string; keyVersions: Array<{ keyHash: string }> }> };
    };
    expect(persisted.apiKeys.clients.some((client) => client.id === "cli-client")).toBe(true);

    const exportPath = path.join(tempDir, "export.json");
    const exportResult = await runCli([
      "control",
      "export",
      "--file",
      "opengate.config.json",
      "--out",
      exportPath
    ], tempDir);

    expect(exportResult.exitCode).toBe(0);
    expect(fs.existsSync(exportPath)).toBe(true);

    const importPath = path.join(tempDir, "import.json");
    const importedConfig = makeControlPlaneConfig();
    importedConfig.organizations[0].name = "Imported Org";
    fs.writeFileSync(importPath, JSON.stringify(importedConfig, null, 2));

    const importResult = await runCli([
      "control",
      "import",
      "--file",
      "opengate.config.json",
      "--input",
      importPath
    ], tempDir);

    expect(importResult.exitCode).toBe(0);
    const imported = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      organizations: Array<{ name: string }>;
    };
    expect(imported.organizations[0]?.name).toBe("Imported Org");
  });
});


