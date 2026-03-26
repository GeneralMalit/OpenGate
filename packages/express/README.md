# @opengate/express

Express adapter package for OpenGate.

## Install

```bash
npm install opengate @opengate/express express
```

## Use

```ts
import express from "express";
import { createExpressOpenGate } from "@opengate/express";

const app = express();
const gate = createExpressOpenGate("./opengate.config.json");

gate.registerProtectedRoute(app, {
  path: "/api",
  method: "GET",
  handler: async () => ({ ok: true })
});
```
