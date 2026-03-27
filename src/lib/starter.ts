import { createApiKeyVersionConfig } from "./auth.js";
import type { AccessMode, ApiClientConfig, OpenGateConfig } from "./types.js";

export type StarterRouteMode = "public" | "jwt" | "api_key" | "mixed";
export type StarterTemplateName = "website" | "api" | "partner";

export type StarterBundleOptions = {
  routeMode?: StarterRouteMode;
  template?: StarterTemplateName;
};

export type StarterBundle = {
  config: OpenGateConfig;
  files: Record<string, string>;
  demoCredentials: {
    jwtSecret: string;
    jwtIssuer: string;
    jwtAudience: string;
    apiKey: string | null;
    apiClientId: string | null;
  };
  template: StarterTemplateName | null;
};

const DEFAULT_DEMO_ORG_ID = "demo-org";
const DEFAULT_DEMO_ORG_NAME = "Demo Organization";
const DEFAULT_DEMO_JWT_SECRET = "opengate-demo-shared-secret";
const DEFAULT_DEMO_JWT_ISSUER = "opengate-demo-auth";
const DEFAULT_DEMO_JWT_AUDIENCE = "opengate-example-api";
const DEFAULT_DEMO_API_KEY = "opengate-demo-api-key";
const DEFAULT_ROUTE_PATH = "/api";
const DEFAULT_CONFIG_FILE = "opengate.config.json";
const DEFAULT_AUDIT_PATH = "./data/opengate.db";

export function createStarterBundle(input: StarterRouteMode | StarterBundleOptions = "mixed"): StarterBundle {
  const profile = resolveStarterProfile(input);
  const apiClient = profile.includeApiKey
    ? createDemoApiClient(profile.apiClientId ?? undefined, profile.apiClientName ?? undefined)
    : null;
  const config = createStarterConfig(profile, apiClient);

  const files = {
    [DEFAULT_CONFIG_FILE]: JSON.stringify(config, null, 2),
    "server.ts": buildStarterServerSource(profile),
    "README.md": buildStarterReadme(profile),
    "DEMO-CREDENTIALS.md": buildDemoCredentialsDoc(profile),
    "data/audit-sample.json": JSON.stringify(buildSampleAuditEvents(profile), null, 2)
  };

  return {
    config,
    files,
    demoCredentials: {
      jwtSecret: DEFAULT_DEMO_JWT_SECRET,
      jwtIssuer: DEFAULT_DEMO_JWT_ISSUER,
      jwtAudience: DEFAULT_DEMO_JWT_AUDIENCE,
      apiKey: apiClient ? DEFAULT_DEMO_API_KEY : null,
      apiClientId: apiClient?.id ?? null
    },
    template: profile.template
  };
}

export function routeModeToAccessMode(routeMode: StarterRouteMode): AccessMode {
  if (routeMode === "mixed") {
    return "authenticated";
  }

  return routeMode;
}

export function createDemoApiClient(
  clientId = "demo-client-1",
  clientName = "Demo Service Client"
): ApiClientConfig {
  const rawKey = DEFAULT_DEMO_API_KEY;
  const keyVersion = createApiKeyVersionConfig({
    id: `${clientId}-primary`,
    rawKey,
    createdAt: "2026-03-25T00:00:00.000Z",
    enabled: true
  });

  return {
    id: clientId,
    name: clientName,
    organizationId: DEFAULT_DEMO_ORG_ID,
    userId: "service-user-1",
    keyVersions: [keyVersion],
    scopes: ["time:read"],
    enabled: true
  };
}

function resolveStarterProfile(input: StarterRouteMode | StarterBundleOptions) {
  if (typeof input === "string") {
    return {
      template: null as StarterTemplateName | null,
      routeMode: input,
      title: "OpenGate starter",
      includeApiKey: input === "api_key" || input === "mixed",
      apiClientId: "demo-client-1",
      apiClientName: "Demo Service Client"
    };
  }

  if (input.template === "website") {
    return {
      template: "website" as const,
      routeMode: (input.routeMode ?? "public") as StarterRouteMode,
      title: "Website starter",
      includeApiKey: false,
      apiClientId: null,
      apiClientName: null
    };
  }

  if (input.template === "api") {
    return {
      template: "api" as const,
      routeMode: (input.routeMode ?? "jwt") as StarterRouteMode,
      title: "API starter",
      includeApiKey: false,
      apiClientId: null,
      apiClientName: null
    };
  }

  if (input.template === "partner") {
    return {
      template: "partner" as const,
      routeMode: (input.routeMode ?? "api_key") as StarterRouteMode,
      title: "Partner starter",
      includeApiKey: true,
      apiClientId: "partner-client-1",
      apiClientName: "Partner Service Client"
    };
  }

  return {
    template: null as StarterTemplateName | null,
    routeMode: input.routeMode ?? "mixed",
    title: "OpenGate starter",
    includeApiKey: (input.routeMode ?? "mixed") === "api_key" || (input.routeMode ?? "mixed") === "mixed",
    apiClientId: "demo-client-1",
    apiClientName: "Demo Service Client"
  };
}

function createStarterConfig(
  profile: ReturnType<typeof resolveStarterProfile>,
  apiClient: ApiClientConfig | null
): OpenGateConfig {
  return {
    organizations: [
      {
        id: DEFAULT_DEMO_ORG_ID,
        name: DEFAULT_DEMO_ORG_NAME,
        enabled: true
      }
    ],
    users: createStarterUsers(profile),
    jwt: {
      cookieName: "opengate_demo_jwt",
      issuers: [
        {
          issuer: DEFAULT_DEMO_JWT_ISSUER,
          audiences: [DEFAULT_DEMO_JWT_AUDIENCE],
          enabled: true,
          verificationMode: "shared_secret",
          sharedSecret: DEFAULT_DEMO_JWT_SECRET,
          organizationClaim: "org_id",
          subjectClaim: "sub",
          requiredClaims: ["iss", "aud", "exp", "sub", "unique_user_id"],
          optionalClaims: ["scope"]
        }
      ]
    },
    apiKeys: {
      headerName: "x-api-key",
      clients: apiClient ? [apiClient] : []
    },
    identityContext: {
      source: "jwt_claim",
      claim: "unique_user_id",
      required: true,
      globalUniqueness: "global"
    },
    routePolicies: [
      {
        id: `starter-${profile.template ?? profile.routeMode}`,
        pathPrefix: DEFAULT_ROUTE_PATH,
        accessMode: routeModeToAccessMode(profile.routeMode),
        requiredScopes: [],
        enabled: true
      }
    ],
    rateLimits: {
      timezone: "UTC",
      store: "memory",
      free: { points: 10, duration: "calendar_day" },
      upgraded: { points: 1000, duration: "calendar_day" }
    },
    audit: {
      enabled: true,
      sqlitePath: DEFAULT_AUDIT_PATH,
      jwtClaimSnapshot: ["iss", "aud", "sub", "org_id", "unique_user_id"]
    },
    behavior: {
      onMissingSecondaryIdentifier: "reject",
      onCredentialMismatch: "deny",
      onDisabledOrganization: "block",
      onDisabledUser: "block"
    }
  };
}

function createStarterUsers(profile: ReturnType<typeof resolveStarterProfile>) {
  if (profile.template === "website") {
    return [
      {
        id: "demo-user-ava",
        name: "Ava Demo",
        organizationId: DEFAULT_DEMO_ORG_ID,
        email: "ava@example.com",
        enabled: true
      },
      {
        id: "demo-user-milo",
        name: "Milo Demo",
        organizationId: DEFAULT_DEMO_ORG_ID,
        email: "milo@example.com",
        enabled: true
      }
    ];
  }

  if (profile.template === "api") {
    return [
      {
        id: "api-user-1",
        name: "API User",
        organizationId: DEFAULT_DEMO_ORG_ID,
        email: "api@example.com",
        enabled: true
      }
    ];
  }

  if (profile.template === "partner") {
    return [
      {
        id: "partner-user-1",
        name: "Partner User",
        organizationId: DEFAULT_DEMO_ORG_ID,
        email: "partner@example.com",
        enabled: true
      }
    ];
  }

  return [
    {
      id: "demo-user-1",
      name: "Demo User",
      organizationId: DEFAULT_DEMO_ORG_ID,
      email: "demo@example.com",
      enabled: true
    }
  ];
}

export function buildStarterServerSource(profile: ReturnType<typeof resolveStarterProfile>) {
  if (profile.template === "website") {
    return buildWebsiteStarterServerSource(profile.routeMode);
  }

  if (profile.template === "api") {
    return buildApiStarterServerSource(profile.routeMode);
  }

  if (profile.template === "partner") {
    return buildPartnerStarterServerSource(profile.routeMode);
  }

  return buildGenericStarterServerSource(profile.routeMode);
}

function buildGenericStarterServerSource(routeMode: StarterRouteMode) {
  const accessMode = routeModeToAccessMode(routeMode);
  return [
    'import Fastify from "fastify";',
    'import { createFastifyOpenGate } from "@opengate/fastify";',
    "",
    'const app = Fastify({ logger: false });',
    'const gate = createFastifyOpenGate("./opengate.config.json");',
    "",
    "gate.registerProtectedRoute(app, {",
    '  path: "/api",',
    '  method: "GET",',
    `  accessMode: "${accessMode}",`,
    "  handler: async (request) => {",
    '    const identityType = request.opengate?.identity.identityType ?? "anonymous";',
    '    const upgraded = identityType !== "anonymous";',
    "",
    "    return {",
    '      currentTime: new Date().toISOString(),',
    '      status: "ok",',
    '      ...(upgraded ? { paidTier: true } : {})',
    "    };",
    "  }",
    "});",
    "",
    'app.addHook("onClose", async () => {',
    "  await gate.close();",
    "});",
    "",
    'app.listen({ host: "127.0.0.1", port: 3000 })',
    "  .then(() => {",
    '    app.log.info("OpenGate starter listening on http://127.0.0.1:3000");',
    "  })",
    "  .catch((error) => {",
    "    app.log.error(error);",
    "    process.exit(1);",
    "  });"
  ].join("\n");
}

function buildWebsiteStarterServerSource(routeMode: StarterRouteMode) {
  const accessMode = routeModeToAccessMode(routeMode);
  return [
    'import Fastify from "fastify";',
    'import cookie from "@fastify/cookie";',
    'import formbody from "@fastify/formbody";',
    'import { SignJWT } from "jose";',
    'import { createFastifyOpenGate } from "@opengate/fastify";',
    "",
    'const app = Fastify({ logger: false });',
    'const gate = createFastifyOpenGate("./opengate.config.json");',
    'const cookieName = "opengate_demo_jwt";',
    'const demoUsers = [',
    '  { username: "ava", password: "demo-pass-1", subject: "demo-user-ava", name: "Ava Demo" },',
    '  { username: "milo", password: "demo-pass-2", subject: "demo-user-milo", name: "Milo Demo" }',
    "];",
    "",
    "await app.register(cookie);",
    "await app.register(formbody);",
    "",
    'app.get("/", async (request, reply) => {',
    "  const hasSession = Boolean((request as { cookies?: Record<string, string> }).cookies?.[cookieName]);",
    "  reply.type(\"html\").send(renderHome(hasSession));",
    "});",
    "",
    'app.post("/login", async (request, reply) => {',
    "  const body = (request.body ?? {}) as Record<string, string>;",
    "  const user = demoUsers.find((item) => item.username === body.username?.trim() && item.password === body.password?.trim());",
    "",
    "  if (!user) {",
    "    reply.status(401).type(\"html\").send(renderHome(false, \"Invalid demo credentials\"));",
    "    return;",
    "  }",
    "",
    "  const token = await new SignJWT({",
    "    sub: user.subject,",
    '    org_id: "demo-org",',
    "    unique_user_id: user.subject",
    "  })",
    '    .setProtectedHeader({ alg: "HS256" })',
    '    .setIssuer("opengate-demo-auth")',
    '    .setAudience("opengate-example-api")',
    "    .setIssuedAt()",
    '    .setExpirationTime("1h")',
    '    .sign(new TextEncoder().encode("opengate-demo-shared-secret"));',
    "",
    "  reply.setCookie(cookieName, token, {",
    "    httpOnly: true,",
    '    sameSite: "lax",',
    "    path: \"/\"",
    "  });",
    "",
    '  reply.redirect("/");',
    "});",
    "",
    'app.post("/logout", async (_request, reply) => {',
    "  reply.clearCookie(cookieName, { path: \"/\" });",
    '  reply.redirect("/");',
    "});",
    "",
    "gate.registerProtectedRoute(app, {",
    '  path: "/api",',
    '  method: "GET",',
    `  accessMode: "${accessMode}",`,
    "  handler: async (request) => {",
    '    const identityType = request.opengate?.identity.identityType ?? "anonymous";',
    '    const upgraded = identityType !== "anonymous";',
    "",
    "    return {",
    '      currentTime: new Date().toISOString(),',
    '      status: "ok",',
    '      ...(upgraded ? { paidTier: true } : {})',
    "    };",
    "  }",
    "});",
    "",
    'app.addHook("onClose", async () => {',
    "  await gate.close();",
    "});",
    "",
    "function renderHome(hasSession: boolean, error?: string) {",
    "  const errorLine = error ? `            <p class=\"error\">${error}</p>` : \"\";",
    "  const authBlock = hasSession",
    "    ? '            <form method=\"post\" action=\"/logout\"><button type=\"submit\">Logout</button></form>'",
    "    : [",
    "        '            <form method=\"post\" action=\"/login\">',",
    "        '              <input name=\"username\" placeholder=\"username\" />',",
    "        '              <input name=\"password\" type=\"password\" placeholder=\"password\" />',",
    "        '              <button type=\"submit\">Login</button>',",
    "        '            </form>',",
    "        '            <p class=\"muted\">Try <code>ava / demo-pass-1</code> or <code>milo / demo-pass-2</code>.</p>'",
    "      ].join(\"\\n\");",
    "",
    "  return [",
    "    '<!doctype html>',",
    "    '<html lang=\"en\">',",
    "    '  <head>',",
    "    '    <meta charset=\"utf-8\" />',",
    "    '    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />',",
    "    '    <title>OpenGate Starter</title>',",
    "    '    <style>',",
    "    '      :root { color-scheme: light; }',",
    "    '      body { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; margin: 0; background: #f6f5f2; color: #111; }',",
    "    '      main { max-width: 820px; margin: 0 auto; padding: 32px 20px 48px; }',",
    "    '      .card { background: #fff; border: 1px solid #d7d2c8; padding: 24px; }',",
    "    '      h1 { margin: 0 0 12px; font-size: 2rem; }',",
    "    '      p { line-height: 1.5; }',",
    "    '      form { display: grid; gap: 10px; max-width: 360px; }',",
    "    '      input, button { font: inherit; padding: 12px 14px; border: 1px solid #b9b2a4; background: #fff; }',",
    "    '      button { background: #111; color: #fff; cursor: pointer; }',",
    "    '      .muted { color: #57524a; }',",
    "    '      .error { color: #8f2f2f; }',",
    "    '    </style>',",
    "    '  </head>',",
    "    '  <body>',",
    "    '    <main>',",
    "    '      <section class=\"card\">',",
    "    '        <h1>Website starter</h1>',",
    "    '        <p>OpenGate sits in front of <code>GET /api</code>. Log in to get the upgraded tier response.</p>',",
    "    '        <p class=\"muted\">Route mode: public</p>',",
    "        errorLine || \"\",",
    "        authBlock,",
    "    '        <p><a href=\"/api\">Call the protected API</a></p>',",
    "    '      </section>',",
    "    '    </main>',",
    "    '  </body>',",
    "    '</html>'",
    "  ].join(\"\\n\");",
    "}",
    "",
    "const host = \"127.0.0.1\";",
    "const port = 3000;",
    "",
    "app.listen({ host, port })",
    "  .then(() => {",
    "    app.log.info(`OpenGate website starter listening on http://${host}:${port}`);",
    "  })",
    "  .catch((error) => {",
    "    app.log.error(error);",
    "    process.exit(1);",
    "  });"
  ].join("\n");
}

function buildApiStarterServerSource(routeMode: StarterRouteMode) {
  const accessMode = routeModeToAccessMode(routeMode);
  return [
    'import Fastify from "fastify";',
    'import { createFastifyOpenGate } from "@opengate/fastify";',
    "",
    'const app = Fastify({ logger: false });',
    'const gate = createFastifyOpenGate("./opengate.config.json");',
    "",
    "gate.registerProtectedRoute(app, {",
    '  path: "/api",',
    '  method: "GET",',
    `  accessMode: "${accessMode}",`,
    "  handler: async (request) => ({",
    '    currentTime: new Date().toISOString(),',
    '    status: "ok",',
    '    identityType: request.opengate?.identity.identityType ?? "anonymous"',
    "  })",
    "});",
    "",
    'app.addHook("onClose", async () => {',
    "  await gate.close();",
    "});",
    "",
    'app.listen({ host: "127.0.0.1", port: 3000 })',
    "  .then(() => {",
    '    app.log.info("OpenGate API starter listening on http://127.0.0.1:3000");',
    "  })",
    "  .catch((error) => {",
    "    app.log.error(error);",
    "    process.exit(1);",
    "  });"
  ].join("\n");
}

function buildPartnerStarterServerSource(routeMode: StarterRouteMode) {
  const accessMode = routeModeToAccessMode(routeMode);
  return [
    'import Fastify from "fastify";',
    'import { createFastifyOpenGate } from "@opengate/fastify";',
    "",
    'const app = Fastify({ logger: false });',
    'const gate = createFastifyOpenGate("./opengate.config.json");',
    "",
    "gate.registerProtectedRoute(app, {",
    '  path: "/api",',
    '  method: "GET",',
    `  accessMode: "${accessMode}",`,
    "  handler: async (request) => ({",
    '    currentTime: new Date().toISOString(),',
    '    status: "ok",',
    '    clientId: request.opengate?.identity.identityType === "api_key" ? request.opengate?.identity.apiClientId : null',
    "  })",
    "});",
    "",
    'app.addHook("onClose", async () => {',
    "  await gate.close();",
    "});",
    "",
    'app.listen({ host: "127.0.0.1", port: 3000 })',
    "  .then(() => {",
    '    app.log.info("OpenGate partner starter listening on http://127.0.0.1:3000");',
    "  })",
    "  .catch((error) => {",
    "    app.log.error(error);",
    "    process.exit(1);",
    "  });"
  ].join("\n");
}

function buildStarterReadme(profile: ReturnType<typeof resolveStarterProfile>) {
  if (profile.template === "website") {
    return `# OpenGate Website Starter

This starter shows the full browser-based OpenGate story:

- login with a demo username and password
- store the JWT in an \`HttpOnly\` cookie
- call a hidden \`GET /api\` endpoint
- return the same base JSON shape for free and upgraded access

## Run

\`\`\`bash
npm install opengate @opengate/fastify fastify @fastify/cookie @fastify/formbody
npm run dev
\`\`\`

## Demo users

- \`ava / demo-pass-1\`
- \`milo / demo-pass-2\`

## What to look for

- anonymous requests get the free-tier shape
- logging in upgrades the response with \`paidTier: true\`
- the cookie stays server-managed rather than exposed in the page`;
  }

  if (profile.template === "api") {
    return `# OpenGate API Starter

This starter is the lean JSON API path.

It shows how to protect a single \`GET /api\` route with JWT access and keep the request handler simple.

## Run

\`\`\`bash
npm install opengate @opengate/fastify fastify
npm run dev
\`\`\`

## Try it

Send a valid JWT to \`GET /api\`. The response includes the current time, a status message, and the resolved identity type.`;
  }

  if (profile.template === "partner") {
    return `# OpenGate Partner Starter

This starter is the server-to-server path.

It protects a single \`GET /api\` route with API-key access and keeps the client contract small and explicit.

## Run

\`\`\`bash
npm install opengate @opengate/fastify fastify
npm run dev
\`\`\`

## Try it

Send the raw API key as \`x-api-key\` and call \`GET /api\`.
The response includes the current time, a status message, and the API key client id.`;
  }

  return `# OpenGate Starter

This starter shows the minimal OpenGate integration:

- one protected \`GET /api\` route
- local JSON config
- a simple handler that returns the current time

## Run

\`\`\`bash
npm install opengate @opengate/fastify fastify
npm run dev
\`\`\`

## Next

- update \`opengate.config.json\`
- edit \`server.ts\`
- rotate to the template that fits your app best`;
}

function buildDemoCredentialsDoc(profile: ReturnType<typeof resolveStarterProfile>) {
  const lines = [
    "# OpenGate Demo Credentials",
    "",
    "These values are only for local development.",
    "",
    "## JWT Demo",
    "",
    `- issuer: \`${DEFAULT_DEMO_JWT_ISSUER}\``,
    `- audience: \`${DEFAULT_DEMO_JWT_AUDIENCE}\``,
    `- shared secret: \`${DEFAULT_DEMO_JWT_SECRET}\``
  ];

  if (profile.template === "website") {
    lines.push("", "## Login Demo", "", "- `ava / demo-pass-1`", "- `milo / demo-pass-2`");
  }

  if (profile.includeApiKey) {
    lines.push(
      "",
      "## API-Key Demo",
      "",
      `- raw API key: \`${DEFAULT_DEMO_API_KEY}\``,
      `- client id: \`${profile.apiClientId ?? "demo-client-1"}\``,
      "",
      "OpenGate stores the hashed API key in config. Use the raw value above only when you need to exercise the starter app locally."
    );
  }

  return `${lines.join("\n")}\n`;
}

function buildSampleAuditEvents(profile: ReturnType<typeof resolveStarterProfile>) {
  return [
    {
      occurredAt: "2026-03-25T08:00:00.000Z",
      routePolicyId: `starter-${profile.template ?? profile.routeMode}`,
      identityType: "anonymous",
      organizationId: null,
      secondaryIdentifier: null,
      method: "GET",
      path: DEFAULT_ROUTE_PATH,
      statusCode: 200,
      latencyMs: 2.1,
      outcome: "allowed",
      blockReason: null,
      jwtClaimSnapshot: null,
      note: `Starter template configured as ${profile.routeMode}`
    }
  ];
}
