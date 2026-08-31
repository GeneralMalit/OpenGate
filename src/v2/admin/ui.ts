import { randomBytes } from "node:crypto";

/**
 * Small, dependency-free setup page for the v2 admin API.
 *
 * The page deliberately treats the admin API as the source of truth.  It is
 * a static browser client, so a server can mount `renderSetupPage()` at any
 * same-origin setup URL without coupling the UI to its framework.
 */

export type SetupPageOptions = {
  /** Relative same-origin API prefix. Absolute URLs are intentionally rejected. */
  apiBasePath?: string;
  /** Optional CSRF token emitted by the session middleware. */
  csrfToken?: string;
  /** Optional CSP nonce generated for this response. */
  nonce?: string;
  /** Human-readable product name shown in the page title. */
  title?: string;
};

export type SetupPageResponse = {
  statusCode: 200;
  headers: Record<string, string>;
  body: string;
};

const DEFAULT_API_BASE = "/admin/api";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character] ?? character);
}

function normalizeApiBasePath(value: string | undefined): string {
  const path = value ?? DEFAULT_API_BASE;
  if (!path.startsWith("/") || path.startsWith("//") || /[\r\n]/.test(path) || /^https?:/i.test(path)) {
    throw new Error("Setup API base path must be a relative same-origin path.");
  }
  return path.replace(/\/+$/, "") || DEFAULT_API_BASE;
}

function normalizeNonce(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[A-Za-z0-9+/_-]{1,128}$/.test(value)) throw new Error("Setup page nonce contains invalid characters.");
  return value;
}

function jsonForScript(value: string): string {
  // JSON.stringify escapes quotes; the replacement prevents a value from
  // terminating an inline script in case a caller passes an unusual token.
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

/** Render the v2 administrator setup page. */
export function renderSetupPage(options: SetupPageOptions = {}): string {
  const apiBasePath = normalizeApiBasePath(options.apiBasePath);
  const nonce = normalizeNonce(options.nonce);
  const title = escapeHtml(options.title?.trim() || "OpenGate setup");
  const csrfToken = options.csrfToken ? escapeHtml(options.csrfToken) : "";
  const nonceAttribute = nonce ? ` nonce="${escapeHtml(nonce)}"` : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="csrf-token" content="${csrfToken}">
  <title>${title}</title>
  <style${nonceAttribute}>
    :root { color-scheme: light; font: 16px/1.45 system-ui, sans-serif; }
    body { margin: 0; background: #f5f7fb; color: #172033; }
    main { max-width: 1100px; margin: 0 auto; padding: 2rem 1rem 4rem; }
    header, section { background: #fff; border: 1px solid #dfe4ef; border-radius: 10px; padding: 1rem 1.25rem; margin: 0 0 1rem; }
    h1, h2 { margin: 0 0 .75rem; }
    form { display: grid; gap: .65rem; max-width: 42rem; }
    label { display: grid; gap: .25rem; font-weight: 600; }
    input, select, button { font: inherit; padding: .5rem .65rem; border: 1px solid #b6c0d2; border-radius: 6px; }
    button { cursor: pointer; background: #203b72; color: #fff; border-color: #203b72; }
    button.secondary { background: #fff; color: #203b72; }
    .row { display: flex; flex-wrap: wrap; gap: .65rem; align-items: end; }
    .row > * { flex: 1 1 12rem; }
    table { width: 100%; border-collapse: collapse; margin-top: .75rem; }
    th, td { text-align: left; border-bottom: 1px solid #e5e8ef; padding: .5rem .35rem; vertical-align: top; }
    [hidden] { display: none !important; }
    #message { min-height: 1.45em; color: #8a1d1d; }
    .muted { color: #56627a; }
  </style>
</head>
<body>
<main>
  <header>
    <h1>${title}</h1>
    <p class="muted">Configure upstream APIs, shared roles, consumers, and one role assignment per API.</p>
    <p id="message" role="status" aria-live="polite"></p>
    <form id="login-form" autocomplete="on">
      <label>Email <input name="email" type="email" autocomplete="username" required></label>
      <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
      <button type="submit">Sign in</button>
    </form>
    <button id="logout" class="secondary" type="button" hidden>Sign out</button>
  </header>

  <div id="workspace" hidden>
    <section>
      <h2>Upstream APIs</h2>
      <form id="api-form">
        <div class="row">
          <label>Name <input name="name" required></label>
          <label>Slug <input name="slug" pattern="[a-z0-9-]+" required></label>
          <label>Upstream URL <input name="upstreamBaseUrl" type="url" placeholder="https://api.example.test" required></label>
        </div>
        <button type="submit">Add API</button>
      </form>
      <table><thead><tr><th>Name</th><th>Slug</th><th>Upstream</th><th>Status</th></tr></thead><tbody id="apis"></tbody></table>
    </section>

    <section>
      <h2>Shared roles</h2>
      <form id="role-form">
        <div class="row">
          <label>Name <input name="name" required></label>
          <label>Requests / minute <input name="rateLimitCount" type="number" min="1" step="1" placeholder="optional"></label>
          <label>Window (seconds) <input name="rateLimitWindowSeconds" type="number" min="1" step="1" value="60"></label>
          <label>Quota count <input name="quotaCount" type="number" min="1" step="1" placeholder="optional"></label>
          <label>Quota period <select name="quotaPeriod"><option value="day">day</option><option value="month">month</option></select></label>
        </div>
        <label>Allowed methods and paths (one per line, e.g. GET /v1/items/*)
          <textarea name="permissions" rows="4" placeholder="GET /v1/items/*" required></textarea>
        </label>
        <button type="submit">Add role</button>
      </form>
      <table><thead><tr><th>Role</th><th>Permissions</th><th>Limits</th><th>Status</th></tr></thead><tbody id="roles"></tbody></table>
    </section>

    <section>
      <h2>Consumers</h2>
      <form id="consumer-form">
        <div class="row"><label>Name <input name="name" required></label><label>External ID <input name="externalReference"></label></div>
        <button type="submit">Add consumer</button>
      </form>
      <table><thead><tr><th>Name</th><th>External ID</th><th>Status</th></tr></thead><tbody id="consumers"></tbody></table>
    </section>

    <section>
      <h2>Assign a role and issue a key</h2>
      <p class="muted">A consumer has exactly one role per API. The raw key is shown once and cannot be recovered later.</p>
      <form id="assignment-form">
        <div class="row">
          <label>API <select name="apiId" id="api-select" required></select></label>
          <label>Consumer <select name="consumerId" id="consumer-select" required></select></label>
          <label>Role <select name="roleId" id="role-select" required></select></label>
        </div>
        <button type="submit">Assign role and issue key</button>
      </form>
      <pre id="issued-key" hidden></pre>
    </section>
  </div>
</main>
<script${nonceAttribute}>
(() => {
  "use strict";
  const API = ${jsonForScript(apiBasePath)};
  let csrf = document.querySelector('meta[name="csrf-token"]').getAttribute("content") || "";
  const message = document.getElementById("message");
  const workspace = document.getElementById("workspace");
  const loginForm = document.getElementById("login-form");
  const logout = document.getElementById("logout");
  const setMessage = (value, isError = true) => { message.textContent = value; message.style.color = isError ? "#8a1d1d" : "#176b3a"; };
  const request = async (path, init = {}) => {
    const headers = new Headers(init.headers || {});
    headers.set("Accept", "application/json");
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    if (csrf) headers.set("X-CSRF-Token", csrf);
    const response = await fetch(API + path, { ...init, headers, credentials: "same-origin" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || payload.message || "Request failed");
    return payload;
  };
  const body = (form) => Object.fromEntries(new FormData(form).entries());
  const text = (value) => String(value ?? "");
  const addCell = (row, value) => { const cell = document.createElement("td"); cell.textContent = text(value); row.appendChild(cell); };
  const renderRows = (id, entries, fields) => {
    const target = document.getElementById(id); target.replaceChildren();
    for (const entry of entries || []) { const row = document.createElement("tr"); for (const field of fields) addCell(row, entry[field]); target.appendChild(row); }
  };
  const renderSelect = (id, entries, valueField, labelField) => {
    const target = document.getElementById(id); target.replaceChildren();
    for (const entry of entries || []) { const option = document.createElement("option"); option.value = text(entry[valueField]); option.textContent = text(entry[labelField]); target.appendChild(option); }
  };
  let state = { apis: [], roles: [], consumers: [] };
  const refresh = async () => {
    const [apis, roles, consumers] = await Promise.all([request("/apis"), request("/roles"), request("/consumers")]);
    state = { apis: apis.apis || apis.items || apis, roles: roles.roles || roles.items || roles, consumers: consumers.consumers || consumers.items || consumers };
    renderRows("apis", state.apis, ["name", "slug", "upstreamBaseUrl", "enabled"]);
    renderRows("roles", state.roles, ["name", "permissions", "quotaCount", "enabled"]);
    renderRows("consumers", state.consumers, ["name", "externalReference", "enabled"]);
    renderSelect("api-select", state.apis, "id", "name"); renderSelect("role-select", state.roles, "id", "name"); renderSelect("consumer-select", state.consumers, "id", "name");
  };
  loginForm.addEventListener("submit", async (event) => { event.preventDefault(); try { await request("/auth/login", { method: "POST", body: JSON.stringify(body(loginForm)) }); const csrfResult = await request("/auth/csrf"); csrf = String(csrfResult.csrfToken || ""); loginForm.hidden = true; logout.hidden = false; workspace.hidden = false; await refresh(); setMessage("Signed in.", false); } catch (error) { setMessage(error.message); } });
  logout.addEventListener("click", async () => { try { await request("/auth/logout", { method: "POST" }); } finally { loginForm.hidden = false; logout.hidden = true; workspace.hidden = true; } });
  document.getElementById("api-form").addEventListener("submit", async (event) => { event.preventDefault(); try { await request("/apis", { method: "POST", body: JSON.stringify(body(event.target)) }); event.target.reset(); await refresh(); setMessage("API added.", false); } catch (error) { setMessage(error.message); } });
  document.getElementById("role-form").addEventListener("submit", async (event) => { event.preventDefault(); const value = body(event.target); value.permissions = String(value.permissions).split("\\n").map((line) => { const [method, ...path] = line.trim().split(/\\s+/); return { method, pathPattern: path.join(" ") }; }).filter((entry) => entry.method && entry.pathPattern); for (const field of ["rateLimitCount", "rateLimitWindowSeconds", "quotaCount"]) if (value[field] === "") value[field] = null; try { await request("/roles", { method: "POST", body: JSON.stringify(value) }); event.target.reset(); await refresh(); setMessage("Role added.", false); } catch (error) { setMessage(error.message); } });
  document.getElementById("consumer-form").addEventListener("submit", async (event) => { event.preventDefault(); try { await request("/consumers", { method: "POST", body: JSON.stringify(body(event.target)) }); event.target.reset(); await refresh(); setMessage("Consumer added.", false); } catch (error) { setMessage(error.message); } });
  document.getElementById("assignment-form").addEventListener("submit", async (event) => { event.preventDefault(); try { const value = body(event.target); await request("/assignments", { method: "POST", body: JSON.stringify(value) }); const result = await request("/consumers/" + encodeURIComponent(value.consumerId) + "/keys", { method: "POST", body: JSON.stringify({}) }); const key = result.secret || result.rawKey || result.key; const output = document.getElementById("issued-key"); output.textContent = key ? "Copy this key now; it will not be shown again:\\n" + key : "Assignment saved."; output.hidden = false; setMessage("Assignment saved and key issued.", false); } catch (error) { setMessage(error.message); } });
})();
</script>
</body>
</html>`;
}

/** Framework-neutral response metadata for mounting the page safely. */
export function setupPageResponse(options: SetupPageOptions = {}): SetupPageResponse {
  // A response gets a nonce by default so inline UI code remains usable while
  // retaining a strict CSP. Servers may supply their request-scoped nonce when
  // they already have a CSP middleware in place.
  const nonce = normalizeNonce(options.nonce) ?? randomBytes(18).toString("base64url");
  return {
    statusCode: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": nonce
        ? `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'self'`
        : "default-src 'self'; base-uri 'none'; form-action 'self'"
    },
    body: renderSetupPage({ ...options, nonce })
  };
}
