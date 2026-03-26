# Express Example Website

This is the Express-flavored version of the demo website.

It mirrors the Fastify example:
- visible username/password login
- a single `GET /api` endpoint
- cookie-based demo JWT auth
- OpenGate sitting in front of the protected handler
- browser-local last-success tracking
- a protected `/admin` page for the lightweight control-plane workflows

## Run It

```bash
npm install
npm run express:dev
```

Then open `http://127.0.0.1:3001`.

## Config

The example uses [opengate.config.json](opengate.config.json), which is the same JSON shape as the Fastify demo.

## What To Compare

If you want to see the Fastify version that this folder mirrors, open:

- [../website/server.ts](../website/server.ts)
- [../website/opengate.config.json](../website/opengate.config.json)
