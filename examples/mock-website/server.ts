import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import Fastify from "fastify";
import { SignJWT } from "jose";
import { fileURLToPath } from "node:url";

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

const cookieName = "mock_website_demo_jwt";
const demoIssuer = "mock-website-auth";
const demoAudience = "mock-website-api";
const demoSecret = "mock-website-shared-secret";
const appVersion = process.env.npm_package_version ?? "v0.1.0";

export async function buildMockWebsiteApp() {
  const app = Fastify({ logger: false });

  await app.register(cookie);
  await app.register(formbody);

  app.get("/", async (request, reply) => {
    const requestWithCookies = request as typeof request & { cookies?: Record<string, string> };
    const hasCookie = Boolean(requestWithCookies.cookies?.[cookieName]);
    reply.type("text/html").send(renderHomePage(hasCookie));
  });

  app.post("/login", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, string>;
    const username = body.username?.trim();
    const password = body.password?.trim();
    const user = demoUsers.find((item) => item.username === username && item.password === password);

    if (!user) {
      reply.code(401).type("text/html").send(renderHomePage(false, "Invalid demo credentials"));
      return;
    }

    const token = await new SignJWT({
      sub: user.subject,
      org_id: "demo-org",
      unique_user_id: user.uniqueUserId,
      scope: "time:read",
      display_name: user.displayName
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(demoIssuer)
      .setAudience(demoAudience)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(demoSecret));

    reply
      .setCookie(cookieName, token, {
        httpOnly: true,
        sameSite: "lax",
        path: "/"
      })
      .redirect("/");
  });

  app.post("/logout", async (_request, reply) => {
    reply.clearCookie(cookieName, { path: "/" }).redirect("/");
  });

  app.get("/api", async (request) => {
    const requestWithCookies = request as typeof request & { cookies?: Record<string, string> };
    const signedIn = Boolean(requestWithCookies.cookies?.[cookieName]);

    return {
      currentTime: new Date().toISOString(),
      status: "ok",
      ...(signedIn ? { demoLogin: true } : {})
    };
  });

  return app;
}

function renderHomePage(hasSession: boolean, error?: string) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Mock Website</title>
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
          <p class="muted">Mock website baseline</p>
          <h1>Unprotected /api demo</h1>
          <p>This is the plain website copy before OpenGate is installed. The endpoint is still direct here, so you can see the baseline before wiring the gate in front of it.</p>
        </div>
        ${error ? `<p class="error">${error}</p>` : ""}
        ${
          hasSession
            ? `<form method="post" action="/logout">
          <button type="submit">Logout</button>
        </form>`
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
        <pre id="output">Press "Call /api" to see the plain mock website response.</pre>
        <footer class="footer">(c) 2026 Mock Website - ${appVersion}</footer>
      </div>
    </main>
    <script>
      const output = document.getElementById("output");
      const lastSuccess = document.getElementById("last-success");
      const storageKey = "mock-website:last-success";
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

const __filename = fileURLToPath(import.meta.url);
const isMainModule = process.argv[1] === __filename;

if (isMainModule) {
  const app = await buildMockWebsiteApp();
  const host = "127.0.0.1";
  const port = 3000;

  app.listen({ host, port })
    .then(() => {
      app.log.info(`Mock website listening on http://${host}:${port}`);
    })
    .catch((error) => {
      app.log.error(error);
      process.exit(1);
    });
}
