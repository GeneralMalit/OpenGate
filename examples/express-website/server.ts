import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { SignJWT } from "jose";
import { createExpressOpenGate } from "../../src/index.js";
import { parseCookieHeader } from "../../src/lib/request.js";
import { renderAdminPage } from "../shared/admin-page.js";
import type { OpenGateConfig } from "../../src/lib/types.js";

const __filename = fileURLToPath(import.meta.url);
const DEFAULT_CONFIG_PATH = path.join(process.cwd(), "examples", "express-website", "opengate.config.json");

const demoUsers = [
  {
    username: "ava",
    password: "demo-pass-1",
    subject: "ava-subject",
    uniqueUserId: "demo-user-ava",
    displayName: "Ava"
  },
  {
    username: "milo",
    password: "demo-pass-2",
    subject: "milo-subject",
    uniqueUserId: "demo-user-milo",
    displayName: "Milo"
  }
];

export async function buildExampleApp(configPathOrConfig: string | OpenGateConfig = DEFAULT_CONFIG_PATH) {
  const app = express();
  const gate = createExpressOpenGate(configPathOrConfig);
  const cookieName = gate.config.jwt.cookieName ?? "opengate_demo_jwt";
  const issuerConfig = gate.config.jwt.issuers[0];

  if (!issuerConfig || issuerConfig.verificationMode === "jwks") {
    throw new Error("The example website requires a shared-secret demo JWT issuer.");
  }

  const appVersion = process.env.npm_package_version ?? "v0.1.0";

  app.disable("x-powered-by");
  app.use(express.urlencoded({ extended: false }));

  app.get("/", (request, response) => {
    const cookies = parseCookieHeader(request.headers.cookie);
    const hasCookie = Boolean(cookies?.[cookieName]);
    response.type("html").send(renderHomePage(hasCookie, cookieName, appVersion));
  });

  app.post("/login", (request, response) => {
    const body = (request.body ?? {}) as Record<string, string>;
    const username = body.username?.trim();
    const password = body.password?.trim();
    const user = demoUsers.find((item) => item.username === username && item.password === password);

    if (!user) {
      response.status(401).type("html").send(renderHomePage(false, cookieName, appVersion, "Invalid demo credentials"));
      return;
    }

    void new SignJWT({
      sub: user.subject,
      org_id: "demo-org",
      unique_user_id: user.uniqueUserId,
      scope: "time:read",
      display_name: user.displayName
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(issuerConfig.issuer)
      .setAudience(issuerConfig.audiences[0])
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(issuerConfig.sharedSecret))
      .then((token) => {
        response.cookie(cookieName, token, {
          httpOnly: true,
          sameSite: "lax",
          path: "/"
        });
        response.redirect("/");
      })
      .catch((error) => {
        response.status(500).type("html").send(renderHomePage(false, cookieName, appVersion, String(error)));
      });
  });

  app.post("/logout", (_request, response) => {
    response.clearCookie(cookieName, { path: "/" }).redirect("/");
  });

  gate.registerProtectedRoute(app, {
    path: "/admin",
    method: "GET",
    accessMode: "authenticated",
    handler: async (_request, response) => {
      response.type("html").send(renderAdminPage({ appVersion }));
    }
  });

  gate.registerProtectedRoute(app, {
    path: "/api",
    method: "GET",
    handler: async (request) => {
      const upgraded = request.opengate?.identity.identityType !== "anonymous";

      return {
        currentTime: new Date().toISOString(),
        status: "ok",
        ...(upgraded ? { paidTier: true } : {})
      };
    }
  });

  gate.registerOperationalRoutes(app);

  return { app, gate };
}

function renderHomePage(hasSession: boolean, cookieName: string, appVersion: string, error?: string) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OpenGate Demo</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f3efe5;
        --panel: #fffdf7;
        --ink: #22201a;
        --muted: #6c6558;
        --accent: #2f6d62;
        --line: #d9d0c0;
      }
      body {
        margin: 0;
        font-family: Georgia, "Times New Roman", serif;
        background: radial-gradient(circle at top, #fff7e8 0%, var(--bg) 60%);
        color: var(--ink);
      }
      main {
        max-width: 820px;
        margin: 40px auto;
        padding: 24px;
      }
      .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 18px;
        padding: 24px;
        box-shadow: 0 18px 60px rgba(34, 32, 26, 0.08);
      }
      h1 {
        margin-top: 0;
      }
      .row {
        display: grid;
        gap: 16px;
      }
      form {
        display: grid;
        gap: 12px;
      }
      input, button {
        font: inherit;
        padding: 12px 14px;
        border-radius: 12px;
        border: 1px solid var(--line);
      }
      button {
        background: var(--accent);
        color: white;
        cursor: pointer;
      }
      pre {
        min-height: 140px;
        background: #1f1f1c;
        color: #f5f0e5;
        border-radius: 14px;
        padding: 18px;
        overflow: auto;
      }
      .muted {
        color: var(--muted);
      }
      .error {
        color: #9f2d2d;
      }
      .footer {
        margin-top: 6px;
        padding-top: 12px;
        border-top: 1px solid var(--line);
        color: var(--muted);
        font-size: 0.9rem;
      }
    </style>
  </head>
  <body>
    <main>
      <div class="panel row">
        <div>
          <p class="muted">OpenGate example website</p>
          <h1>Protected endpoint demo</h1>
          <p>The browser only knows about <code>GET /api</code>. OpenGate sits in front of the real handler and decides whether this call is free-tier or upgraded-tier.</p>
          <p class="muted">Demo cookie: <code>${cookieName}</code></p>
        </div>
        ${error ? `<p class="error">${error}</p>` : ""}
        ${
          hasSession
            ? `<form method="post" action="/logout">
          <button type="submit">Logout</button>
        </form>
        <p class="muted"><a href="/admin">Open admin</a> to inspect users, keys, and policies.</p>`
            : `<form method="post" action="/login">
          <input name="username" placeholder="username" />
          <input name="password" type="password" placeholder="password" />
          <button type="submit">Login</button>
          <p class="muted">Try <code>ava / demo-pass-1</code> or <code>milo / demo-pass-2</code>.</p>
        </form>`
        }
        <div>
          <button id="call-api" type="button">Call /api</button>
          <p class="muted">Last successful access: <span id="last-success">never</span></p>
        </div>
        <pre id="output">Press "Call /api" to see OpenGate in action.</pre>
        <footer class="footer">(c) 2026 OpenGate by General Malit - ${appVersion}</footer>
      </div>
    </main>
    <script>
      const output = document.getElementById("output");
      const lastSuccess = document.getElementById("last-success");
      const storageKey = "opengate:last-success";
      const existing = window.localStorage.getItem(storageKey);
      if (existing) {
        lastSuccess.textContent = existing;
      }

      document.getElementById("call-api").addEventListener("click", async () => {
        const response = await fetch("/api");
        const payload = await response.json();
        output.textContent = JSON.stringify(payload, null, 2);
        if (response.ok && payload.currentTime) {
          window.localStorage.setItem(storageKey, payload.currentTime);
          lastSuccess.textContent = payload.currentTime;
        }
      });
    </script>
  </body>
</html>`;
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  const { app, gate } = await buildExampleApp();
  const host = "127.0.0.1";
  const port = 3001;

  const server = app.listen(port, host, () => {
    console.log(`OpenGate example listening on http://${host}:${port}`);
  });

  server.on("close", () => gate.close());
}
