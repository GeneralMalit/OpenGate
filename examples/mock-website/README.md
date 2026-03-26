# Mock Website Baseline

This folder is a plain copy of the demo website before OpenGate is installed.

It gives you a clean starting point:
- a visible login page
- a direct `GET /api` endpoint
- browser-local "last successful access" state
- no OpenGate wiring yet

Use this baseline if you want to see the exact before/after shape of the integration.

## Run The Baseline

```bash
npm install
npm run mock:dev
```

If you prefer, run the file directly with `tsx` from the repo root:

```bash
npx tsx examples/mock-website/server.ts
```

## Install OpenGate Step By Step

The plain website currently has a direct `/api` route in [server.ts](server.ts). The protected version you are aiming for is the one in [../website/server.ts](../website/server.ts).

### 1. Add OpenGate as a dependency

In the project that owns this website, install OpenGate from the workspace or from your published package source.

If you are working inside this repository, the library code is already present. If you are copying this folder into a different app, add OpenGate there first.

### 2. Create an OpenGate config file

Start with the demo/shared-secret config in the main OpenGate docs, or generate one with:

```bash
opengate init --route mixed
```

For this website, keep the route pointed at `/api`.

The generated config should end up with the same main pieces as the protected example:

```json
{
  "jwt": {
    "issuers": [
      {
        "verificationMode": "shared_secret",
        "sharedSecret": "demo-shared-secret"
      }
    ]
  },
  "routePolicies": [
    {
      "pathPrefix": "/api",
      "accessMode": "public"
    }
  ]
}
```

### 3. Replace the direct `/api` route with OpenGate

In this baseline file, replace the direct route:

```ts
app.get("/api", async (request) => {
  const requestWithCookies = request as typeof request & { cookies?: Record<string, string> };
  const signedIn = Boolean(requestWithCookies.cookies?.[cookieName]);

  return {
    currentTime: new Date().toISOString(),
    status: "ok",
    ...(signedIn ? { demoLogin: true } : {})
  };
});
```

with the OpenGate wrapper pattern:

```ts
import { createOpenGate } from "opengate";

const gate = createOpenGate("./opengate.config.json");

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
```

If you want the shortest possible mental diff, it is basically this:

```diff
- app.get("/api", async (request) => {
-   return {
-     currentTime: new Date().toISOString(),
-     status: "ok"
-   };
- });
+ const gate = createOpenGate("./opengate.config.json");
+
+ gate.registerProtectedRoute(app, {
+   path: "/api",
+   method: "GET",
+   handler: async (request) => ({
+     currentTime: new Date().toISOString(),
+     status: "ok",
+     ...(request.opengate?.identity.identityType !== "anonymous" ? { paidTier: true } : {})
+   })
+ });
```

### 4. Keep the login flow

The login page can stay the same. It should mint or set the JWT cookie for the demo user, and OpenGate will start using it once the route is protected.

Use the same cookie name in your config so the JWT from the login form is the one OpenGate reads.

### 5. Validate the config

Run:

```bash
opengate validate --file opengate.config.json
```

If you are still migrating from older config shapes, run:

```bash
opengate migrate --file opengate.config.json
```

### 6. Test the four core flows

1. Open `/` and confirm the mock website loads.
2. Click `Call /api` and confirm the free-tier response works.
3. Log in and confirm the upgraded flow works once OpenGate is wired in.
4. Trigger the rate limit and confirm the `rate limited` response.

If something feels off, compare your modified file against [../website/server.ts](../website/server.ts). That file is the working protected version in this repo.

## What Changes After OpenGate Is Installed

- anonymous traffic is classified as free-tier automatically
- logged-in demo traffic upgrades through JWT
- API-key traffic can be added for server-to-server use cases
- audit logging records the matched route policy and request outcome

The protected version of this same website lives in [../website](../website).
