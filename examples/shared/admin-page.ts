export type AdminPageOptions = {
  appVersion: string;
  basePath?: string;
};

export function renderAdminPage(options: AdminPageOptions) {
  const basePath = options.basePath ?? "/admin";
  const basePathJson = JSON.stringify(basePath);
  const appVersionJson = JSON.stringify(options.appVersion);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OpenGate admin</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f3efe5;
        --panel: #fffdf7;
        --ink: #22201a;
        --muted: #6c6558;
        --accent: #2f6d62;
        --accent-weak: #dfe8e2;
        --line: #d9d0c0;
        --soft: #f7f2e7;
        --danger: #8d3c3c;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: Georgia, "Times New Roman", serif;
        background: linear-gradient(180deg, #fbf6eb 0%, var(--bg) 100%);
        color: var(--ink);
      }
      .shell {
        max-width: 1280px;
        margin: 0 auto;
        padding: 24px;
      }
      .topbar {
        display: flex;
        align-items: end;
        justify-content: space-between;
        gap: 16px;
        border-bottom: 1px solid var(--line);
        padding-bottom: 16px;
      }
      .topbar h1 {
        margin: 0;
        font-size: 1.5rem;
      }
      .topbar p {
        margin: 6px 0 0;
        color: var(--muted);
        font-size: 0.95rem;
      }
      .actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      button, input, textarea, select { font: inherit; }
      button {
        padding: 10px 12px;
        border-radius: 10px;
        border: 1px solid var(--line);
        background: #fff;
        color: var(--ink);
        cursor: pointer;
      }
      button.primary {
        background: var(--accent);
        color: white;
        border-color: var(--accent);
      }
      button.ghost { background: transparent; }
      button:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      .layout {
        display: grid;
        grid-template-columns: minmax(0, 1.1fr) 340px;
        gap: 18px;
        align-items: start;
        margin-top: 18px;
      }
      .stack {
        display: grid;
        gap: 14px;
      }
      .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: 16px;
      }
      .section h2 {
        margin: 0 0 10px;
        font-size: 1.05rem;
      }
      .section-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 10px;
      }
      .small {
        color: var(--muted);
        font-size: 0.92rem;
      }
      .notice {
        padding: 10px 12px;
        border: 1px solid var(--line);
        border-radius: 10px;
        background: var(--soft);
      }
      .form-grid {
        display: grid;
        gap: 10px;
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .form-grid .full { grid-column: 1 / -1; }
      label {
        display: grid;
        gap: 6px;
        font-size: 0.95rem;
      }
      input, textarea, select {
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 10px 11px;
        background: #fff;
        color: var(--ink);
      }
      textarea {
        min-height: 84px;
        resize: vertical;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.95rem;
      }
      th, td {
        padding: 10px 8px;
        border-bottom: 1px solid var(--line);
        vertical-align: top;
        text-align: left;
      }
      th {
        color: var(--muted);
        font-weight: 600;
      }
      .row-actions {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }
      .muted { color: var(--muted); }
      .error { color: var(--danger); }
      pre {
        margin: 0;
        background: #1f1f1c;
        color: #f5f0e5;
        border-radius: 12px;
        padding: 12px;
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-word;
      }
      code {
        font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
      }
      .summary-grid {
        display: grid;
        gap: 10px;
      }
      .summary-item {
        padding: 10px 12px;
        border: 1px solid var(--line);
        border-radius: 10px;
        background: #fff;
      }
      .summary-item strong {
        display: block;
        margin-bottom: 4px;
      }
      @media (max-width: 980px) {
        .layout { grid-template-columns: 1fr; }
        .form-grid { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <header class="topbar">
        <div>
          <h1>OpenGate admin</h1>
          <p>Inspect config, simulate requests, and rotate credentials without leaving the app.</p>
        </div>
        <div class="actions">
          <button id="refresh" type="button" class="primary">Refresh</button>
          <button id="download" type="button" class="ghost">Download config</button>
        </div>
      </header>

      <main class="layout">
        <div class="stack">
          <section class="panel section">
            <div class="section-head">
              <h2>Simulate</h2>
              <span id="status-line" class="small">Loading...</span>
            </div>
            <form id="simulate-form" class="form-grid">
              <label>
                Method
                <select name="method">
                  <option>GET</option>
                  <option>POST</option>
                  <option>PUT</option>
                  <option>PATCH</option>
                  <option>DELETE</option>
                </select>
              </label>
              <label>
                Path
                <input name="path" value="/api" />
              </label>
              <label class="full">
                Headers as JSON
                <textarea name="headers">{}</textarea>
              </label>
              <label class="full">
                Cookies as JSON
                <textarea name="cookies">{}</textarea>
              </label>
              <label>
                Request IP
                <input name="ip" placeholder="127.0.0.1" />
              </label>
              <label>
                Request ID
                <input name="requestId" placeholder="optional" />
              </label>
              <div class="full">
                <button type="submit" class="primary">Run simulation</button>
              </div>
            </form>
            <div class="notice" id="simulation-summary">No simulation yet.</div>
            <pre id="simulation-output">Use the form to check a path.</pre>
          </section>

          <section class="panel section">
            <div class="section-head">
              <h2>Organizations</h2>
              <span class="small">Enable or disable tenants.</span>
            </div>
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Name</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody id="organizations-body"></tbody>
            </table>
          </section>

          <section class="panel section">
            <div class="section-head">
              <h2>Users</h2>
              <span class="small">Secondary identities used by JWT and API keys.</span>
            </div>
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Organization</th>
                  <th>Name</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody id="users-body"></tbody>
            </table>
          </section>

          <section class="panel section">
            <div class="section-head">
              <h2>Route policies</h2>
              <span class="small">Read the current policy map.</span>
            </div>
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Prefix</th>
                  <th>Access</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody id="policies-body"></tbody>
            </table>
          </section>

          <section class="panel section">
            <div class="section-head">
              <h2>API keys</h2>
              <span class="small">View clients, versions, and live status.</span>
            </div>
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Owner</th>
                  <th>Versions</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody id="api-keys-body"></tbody>
            </table>
          </section>
        </div>

        <aside class="stack">
          <section class="panel section">
            <div class="section-head">
              <h2>Issue API key</h2>
              <span class="small">Create a client and first version.</span>
            </div>
            <form id="issue-form" class="stack">
              <label>
                Client ID
                <input name="clientId" placeholder="optional" />
              </label>
              <label>
                Name
                <input name="name" placeholder="Partner client" />
              </label>
              <label>
                Organization ID
                <input name="organizationId" value="demo-org" />
              </label>
              <label>
                User ID
                <input name="userId" placeholder="service-user-1" />
              </label>
              <label>
                Raw key
                <input name="rawKey" placeholder="optional" />
              </label>
              <label>
                Scopes
                <input name="scopes" placeholder="time:read,admin:read" />
              </label>
              <button type="submit" class="primary">Issue key</button>
            </form>
          </section>

          <section class="panel section">
            <div class="section-head">
              <h2>Import config</h2>
              <span class="small">Load a JSON file into the same model.</span>
            </div>
            <form id="import-form" class="stack">
              <label>
                JSON file
                <input name="file" type="file" accept="application/json,.json" />
              </label>
              <button type="submit">Import</button>
            </form>
          </section>

          <section class="panel section">
            <div class="section-head">
              <h2>Summary</h2>
              <span class="small">Current state snapshot.</span>
            </div>
            <div class="summary-grid">
              <div class="summary-item">
                <strong>Last refresh</strong>
                <span id="last-refresh">Never</span>
              </div>
              <div class="summary-item">
                <strong>Counts</strong>
                <span id="counts-summary">Loading...</span>
              </div>
              <div class="summary-item">
                <strong>Control plane</strong>
                <span>Phase 6 / JSON backed</span>
              </div>
              <div class="summary-item">
                <strong>Build</strong>
                <span>${appVersionJson}</span>
              </div>
            </div>
          </section>
        </aside>
      </main>
    </div>

    <script>
      const basePath = ${basePathJson};
      const state = {
        organizations: [],
        users: [],
        apiKeys: [],
        routePolicies: []
      };
      const organizationBody = document.getElementById("organizations-body");
      const usersBody = document.getElementById("users-body");
      const apiKeysBody = document.getElementById("api-keys-body");
      const policiesBody = document.getElementById("policies-body");
      const statusLine = document.getElementById("status-line");
      const simulationSummary = document.getElementById("simulation-summary");
      const simulationOutput = document.getElementById("simulation-output");
      const countsSummary = document.getElementById("counts-summary");
      const lastRefresh = document.getElementById("last-refresh");

      function jsonHeaders() {
        return { "content-type": "application/json" };
      }

      async function requestJson(url, options = {}) {
        const response = await fetch(url, {
          ...options,
          headers: {
            ...jsonHeaders(),
            ...(options.headers || {})
          }
        });
        const text = await response.text();
        const body = text ? safeParseJson(text) : null;
        if (!response.ok) {
          const message = body && typeof body === "object" && body.error ? body.error : response.statusText;
          throw new Error(message || "Request failed");
        }
        return body;
      }

      function safeParseJson(text) {
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      }

      function clearNode(node) {
        while (node.firstChild) {
          node.removeChild(node.firstChild);
        }
      }

      function cell(text) {
        const td = document.createElement("td");
        td.textContent = text;
        return td;
      }

      function actionCell(buttons) {
        const td = document.createElement("td");
        const wrap = document.createElement("div");
        wrap.className = "row-actions";
        for (const button of buttons) {
          if (button) {
            wrap.appendChild(button);
          }
        }
        td.appendChild(wrap);
        return td;
      }

      function makeActionButton(label, onClick, kind) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        if (kind === "primary") {
          button.className = "primary";
        }
        button.addEventListener("click", onClick);
        return button;
      }

      function splitCsv(raw) {
        if (!raw) {
          return undefined;
        }

        return raw.split(",").map((item) => item.trim()).filter(Boolean);
      }

      function optionalField(form, name) {
        const value = form.get(name);
        if (typeof value !== "string") {
          return undefined;
        }

        const trimmed = value.trim();
        return trimmed.length ? trimmed : undefined;
      }

      function parseJsonField(raw) {
        if (!raw.trim()) {
          return undefined;
        }

        return JSON.parse(raw);
      }

      function setCountsSummary() {
        countsSummary.textContent = [
          state.organizations.length + " organizations",
          state.users.length + " users",
          state.apiKeys.length + " API key clients",
          state.routePolicies.length + " route policies"
        ].join(" | ");
      }

      function renderOrganizations() {
        clearNode(organizationBody);
        if (!state.organizations.length) {
          const row = document.createElement("tr");
          const td = document.createElement("td");
          td.colSpan = 4;
          td.className = "small";
          td.textContent = "No organizations configured.";
          row.appendChild(td);
          organizationBody.appendChild(row);
          return;
        }

        for (const organization of state.organizations) {
          const row = document.createElement("tr");
          row.append(
            cell(organization.id),
            cell(organization.name),
            cell(organization.enabled === false ? "Disabled" : "Enabled"),
            actionCell([
              organization.enabled === false
                ? makeActionButton("Enable", async () => {
                    await requestJson(basePath + "/organizations/" + encodeURIComponent(organization.id) + "/enable", { method: "POST" });
                    await refreshAll();
                  })
                : makeActionButton("Disable", async () => {
                    await requestJson(basePath + "/organizations/" + encodeURIComponent(organization.id) + "/disable", { method: "POST" });
                    await refreshAll();
                  })
            ])
          );
          organizationBody.appendChild(row);
        }
      }

      function renderUsers() {
        clearNode(usersBody);
        if (!state.users.length) {
          const row = document.createElement("tr");
          const td = document.createElement("td");
          td.colSpan = 5;
          td.className = "small";
          td.textContent = "No users configured.";
          row.appendChild(td);
          usersBody.appendChild(row);
          return;
        }

        for (const user of state.users) {
          const row = document.createElement("tr");
          row.append(
            cell(user.id),
            cell(user.organizationId),
            cell(user.name),
            cell(user.enabled === false ? "Disabled" : "Enabled"),
            actionCell([
              user.enabled === false
                ? makeActionButton("Enable", async () => {
                    await requestJson(basePath + "/users/" + encodeURIComponent(user.id) + "/enable", { method: "POST" });
                    await refreshAll();
                  })
                : makeActionButton("Disable", async () => {
                    await requestJson(basePath + "/users/" + encodeURIComponent(user.id) + "/disable", { method: "POST" });
                    await refreshAll();
                  })
            ])
          );
          usersBody.appendChild(row);
        }
      }

      function renderPolicies() {
        clearNode(policiesBody);
        if (!state.routePolicies.length) {
          const row = document.createElement("tr");
          const td = document.createElement("td");
          td.colSpan = 5;
          td.className = "small";
          td.textContent = "No route policies configured.";
          row.appendChild(td);
          policiesBody.appendChild(row);
          return;
        }

        for (const policy of state.routePolicies) {
          const row = document.createElement("tr");
          row.append(
            cell(policy.id),
            cell(policy.pathPrefix),
            cell(policy.accessMode),
            cell(policy.enabled === false ? "Disabled" : "Enabled"),
            actionCell([
              policy.enabled === false
                ? makeActionButton("Enable", async () => {
                    await requestJson(basePath + "/route-policies/" + encodeURIComponent(policy.id) + "/enable", { method: "POST" });
                    await refreshAll();
                  })
                : makeActionButton("Disable", async () => {
                    await requestJson(basePath + "/route-policies/" + encodeURIComponent(policy.id) + "/disable", { method: "POST" });
                    await refreshAll();
                  })
            ])
          );
          policiesBody.appendChild(row);
        }
      }

      function renderApiKeys() {
        clearNode(apiKeysBody);
        if (!state.apiKeys.length) {
          const row = document.createElement("tr");
          const td = document.createElement("td");
          td.colSpan = 5;
          td.className = "small";
          td.textContent = "No API key clients configured.";
          row.appendChild(td);
          apiKeysBody.appendChild(row);
          return;
        }

        for (const client of state.apiKeys) {
          const versionCount = Array.isArray(client.keyVersions) ? client.keyVersions.length : 0;
          const latestVersion = versionCount > 0 ? client.keyVersions[versionCount - 1] : null;
          const row = document.createElement("tr");
          row.append(
            cell(client.id),
            cell(client.organizationId + " / " + client.userId),
            cell(versionCount > 0 ? versionCount + " versions" : "0 versions"),
            cell(client.enabled === false ? "Disabled" : "Enabled"),
            actionCell([
              client.enabled === false
                ? makeActionButton("Enable", async () => {
                    await requestJson(basePath + "/api-keys/" + encodeURIComponent(client.id) + "/enable", { method: "POST" });
                    await refreshAll();
                  })
                : makeActionButton("Disable", async () => {
                    await requestJson(basePath + "/api-keys/" + encodeURIComponent(client.id) + "/disable", { method: "POST" });
                    await refreshAll();
                  }),
              latestVersion
                ? makeActionButton("Revoke latest", async () => {
                    await requestJson(basePath + "/api-keys/" + encodeURIComponent(client.id) + "/revoke", {
                      method: "POST",
                      body: JSON.stringify({ versionId: latestVersion.id })
                    });
                    await refreshAll();
                  })
                : null
            ].filter(Boolean))
          );
          apiKeysBody.appendChild(row);
        }
      }

      async function refreshAll() {
        statusLine.textContent = "Refreshing...";
        try {
          const [organizations, users, apiKeys, routePolicies] = await Promise.all([
            requestJson(basePath + "/organizations"),
            requestJson(basePath + "/users"),
            requestJson(basePath + "/api-keys"),
            requestJson(basePath + "/route-policies")
          ]);
          state.organizations = Array.isArray(organizations) ? organizations : [];
          state.users = Array.isArray(users) ? users : [];
          state.apiKeys = Array.isArray(apiKeys) ? apiKeys : [];
          state.routePolicies = Array.isArray(routePolicies) ? routePolicies : [];
          renderOrganizations();
          renderUsers();
          renderApiKeys();
          renderPolicies();
          setCountsSummary();
          statusLine.textContent = "Ready";
          lastRefresh.textContent = new Date().toLocaleString();
        } catch (error) {
          statusLine.textContent = "Refresh failed";
          simulationSummary.textContent = String(error instanceof Error ? error.message : error);
        }
      }

      document.getElementById("refresh").addEventListener("click", () => {
        void refreshAll();
      });

      document.getElementById("download").addEventListener("click", async () => {
        const response = await fetch(basePath + "/export");
        const text = await response.text();
        const blob = new Blob([text], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "opengate.config.json";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
      });

      document.getElementById("simulate-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const payload = {
          method: String(form.get("method") || "GET"),
          path: String(form.get("path") || "/api"),
          headers: parseJsonField(String(form.get("headers") || "{}")),
          cookies: parseJsonField(String(form.get("cookies") || "{}")),
          ip: optionalField(form, "ip"),
          requestId: optionalField(form, "requestId")
        };

        try {
          const result = await requestJson(basePath + "/simulate", {
            method: "POST",
            body: JSON.stringify(payload)
          });
          simulationSummary.textContent = result.allowed
            ? "Allowed via " + result.routePolicyId
            : "Blocked: " + result.message;
          simulationOutput.textContent = JSON.stringify(result, null, 2);
        } catch (error) {
          simulationSummary.textContent = "Simulation failed";
          simulationOutput.textContent = String(error instanceof Error ? error.message : error);
        }
      });

      document.getElementById("issue-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const payload = {
          clientId: optionalField(form, "clientId"),
          name: String(form.get("name") || "").trim(),
          organizationId: String(form.get("organizationId") || "").trim(),
          userId: String(form.get("userId") || "").trim(),
          rawKey: optionalField(form, "rawKey"),
          scopes: splitCsv(optionalField(form, "scopes"))
        };

        try {
          await requestJson(basePath + "/api-keys/issue", {
            method: "POST",
            body: JSON.stringify(payload)
          });
          event.currentTarget.reset();
          await refreshAll();
          simulationSummary.textContent = "Issued API key client.";
        } catch (error) {
          simulationSummary.textContent = String(error instanceof Error ? error.message : error);
        }
      });

      document.getElementById("import-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const file = form.get("file");
        if (!(file instanceof File)) {
          simulationSummary.textContent = "Choose a JSON file first.";
          return;
        }

        const text = await file.text();
        try {
          await requestJson(basePath + "/import", {
            method: "POST",
            body: text
          });
          await refreshAll();
          simulationSummary.textContent = "Imported config.";
        } catch (error) {
          simulationSummary.textContent = String(error instanceof Error ? error.message : error);
        }
      });

      void refreshAll();
    </script>
  </body>
</html>`;
}
