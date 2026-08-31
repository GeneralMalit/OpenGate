import { describe, expect, it } from "vitest";
import { createBootstrapAdminInput, createServeOptions, parseV2Cli, runV2Cli } from "../../src/v2/cli.js";
import { renderSetupPage, setupPageResponse } from "../../src/v2/admin/ui.js";

describe("v2 CLI", () => {
  it("parses bootstrap-admin without accepting passwords in argv", () => {
    expect(parseV2Cli(["bootstrap-admin", "--email", "Admin@Example.test"])).toEqual({
      command: "bootstrap-admin",
      options: { email: "Admin@Example.test" }
    });
    expect(() => parseV2Cli(["bootstrap-admin", "--email", "a@b.test", "--password", "not-safe"])).toThrow(/command-line/);
  });

  it("builds serve options from flags and deployment environment", () => {
    expect(createServeOptions({ OPENGATE_KEY_PEPPER: "pepper", OPENGATE_SESSION_SECRET: "session" }, {
      host: "0.0.0.0", port: "9090", database: "./gateway.sqlite", "trusted-proxy-hops": "2", "public-base-url": "https://gateway.test",
      "key-pepper": "flag-pepper", "session-secret": "flag-session"
    })).toEqual({
      host: "0.0.0.0", port: 9090, databaseUrl: "./gateway.sqlite", keyPepper: "flag-pepper", sessionSecret: "flag-session",
      publicBaseUrl: "https://gateway.test", trustedProxyHops: 2
    });
    expect(() => createServeOptions({}, { port: "70000" })).toThrow(/between/);
  });

  it("runs bootstrap-admin using stdin without printing the password", async () => {
    const received: { email?: string; password?: string } = {};
    const output: string[] = [];
    const result = await runV2Cli(["bootstrap-admin", "--email", "Admin@Example.test", "--password-stdin"], {
      io: { write: (line) => output.push(line), error: () => undefined, readStdin: async () => "a secure password\n" },
      runtime: { bootstrapAdmin: async (input) => { received.email = input.email; received.password = input.password; }, serve: () => undefined }
    });
    expect(result.exitCode).toBe(0);
    expect(received).toEqual({ email: "admin@example.test", password: "a secure password" });
    expect(output.join("\n")).not.toContain("a secure password");
  });
});
describe("v2 setup UI", () => {
  it("renders same-origin API calls and the core setup workflows", () => {
    const html = renderSetupPage({ apiBasePath: "/control/api", csrfToken: "csrf-token", nonce: "nonce-1" });
    expect(html).toContain("/control/api");
    expect(html).toContain("/auth/login");
    expect(html).toContain("/assignments");
    expect(html).toContain("one role per API");
    expect(html).toContain('nonce="nonce-1"');
    expect(html).not.toContain("https://control/api");
  });

  it("escapes display metadata and returns no-store security headers", () => {
    const response = setupPageResponse({ title: "<unsafe>", csrfToken: "\" onfocus=alert(1)", nonce: "n" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.body).toContain("&lt;unsafe&gt;");
    expect(response.body).not.toContain('<title><unsafe>');
  });

  it("normalizes and validates the bootstrap input", () => {
    expect(createBootstrapAdminInput(" Admin@Example.test ", "a secure password")).toEqual({ email: "admin@example.test", password: "a secure password" });
    expect(() => createBootstrapAdminInput("not-an-email", "a secure password")).toThrow(/email/);
    expect(() => createBootstrapAdminInput("admin@example.test", "short")).toThrow(/12 characters/);
  });
});

