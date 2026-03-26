# @opengate/fastify

Fastify adapter package for OpenGate.

## Install

```bash
npm install opengate @opengate/fastify fastify
```

## Use

```ts
import Fastify from "fastify";
import { createFastifyOpenGate } from "@opengate/fastify";

const app = Fastify();
const gate = createFastifyOpenGate("./opengate.config.json");

gate.registerProtectedRoute(app, {
  path: "/api",
  method: "GET",
  handler: async () => ({ ok: true })
});
```
