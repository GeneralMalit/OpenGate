# OpenGate

OpenGate is a library-first security gate for existing HTTP API endpoints. You install it inside your backend, point it at the route you want to protect, and it handles caller identification, tiering, rate limiting, and audit logging before your handler runs.

## Tech Stack

<table>
  <tr>
    <td><img src="https://img.shields.io/badge/Fastify-4.26.2-111111?style=for-the-badge&logo=fastify&logoColor=white" alt="Fastify 4.26.2" /></td>
    <td><img src="https://img.shields.io/badge/TypeScript-5.4.5-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript 5.4.5" /></td>
    <td><img src="https://img.shields.io/badge/Zod-3.24.1-3E67B1?style=for-the-badge" alt="Zod 3.24.1" /></td>
    <td><img src="https://img.shields.io/badge/JOSE-5.9.6-444444?style=for-the-badge" alt="JOSE 5.9.6" /></td>
  </tr>
  <tr>
    <td><img src="https://img.shields.io/badge/Better--SQLite3-11.5.0-4D4D4D?style=for-the-badge" alt="Better-SQLite3 11.5.0" /></td>
    <td><img src="https://img.shields.io/badge/Vitest-2.1.8-6E9F18?style=for-the-badge" alt="Vitest 2.1.8" /></td>
    <td><img src="https://img.shields.io/badge/%40fastify%2Fcookie-9.4.0-7A7A7A?style=for-the-badge" alt="@fastify/cookie 9.4.0" /></td>
    <td><img src="https://img.shields.io/badge/%40fastify%2Fformbody-7.4.0-7A7A7A?style=for-the-badge" alt="@fastify/formbody 7.4.0" /></td>
  </tr>
</table>

## Screenshots

Anonymous request state:

![OpenGate anonymous example](docs/screenshots/example-anonymous.png)

Upgraded request state after login and `/api` access:

![OpenGate upgraded example](docs/screenshots/example-upgraded.png)

## How It Works

OpenGate sits between the request and the handler that eventually serves it. The host app still owns the route and the business logic, but OpenGate becomes the layer that decides whether the request should reach that logic at all.

Before installation, the endpoint is exposed directly:

```mermaid
flowchart LR
  client[Client] --> app[Host App]
  app --> handler[Route Handler]
```

After installation, OpenGate sits in front of the handler:

```mermaid
flowchart LR
  client[Client] --> gate[OpenGate]
  gate --> handler[Protected Handler]
```

The request flow is deliberately small and predictable:

```mermaid
flowchart TD
  req[Incoming Request] --> policy[Resolve Route Policy]
  policy --> access{Access Mode}
  access -->|public| identify[Resolve Identity Context]
  access -->|authenticated| auth[Check JWT or API Key]
  access -->|jwt| jwt[Validate JWT]
  access -->|api_key| key[Validate API Key]
  jwt --> identify
  key --> identify
  auth --> identify
  identify --> rate[Apply Rate Limit]
  rate --> audit[Write Audit Event]
  audit --> ok{Allowed?}
  ok -->|yes| handler[Run Protected Handler]
  ok -->|no| deny[Return Rejection]
```

Configuration stays local and explicit. The config file is the source of truth, and each section controls one part of the gate:

```mermaid
flowchart LR
  cfg[opengate.config.json]
  cfg --> orgs[Organizations]
  cfg --> jwt[JWT Issuers]
  cfg --> keys[API Keys]
  cfg --> id[Identity Context]
  cfg --> routes[Route Policies]
  cfg --> limits[Rate Limits]
  cfg --> audit[Audit Settings]
  cfg --> behavior[Behavior Overrides]
```

The MVP is Fastify-first, which keeps the integration surface small and practical. The handler you already have is still the handler you keep; OpenGate simply becomes the layer in front of it, with the config file controlling how much of the gate is strict, permissive, or customized.

## Installation

The detailed installation guide lives in [docs/INSTALLATION.md](docs/INSTALLATION.md).

If you are integrating OpenGate into your own endpoint, that guide walks through the config shape, JWT and API-key setup, route registration, and audit storage.

## Example App

The repository includes a separate example app in [examples/website](examples/website). It shows the full flow in a compact form: a fake username/password login, JWT stored in an `HttpOnly` cookie, a single `GET /api` endpoint, and the same base response shape for free-tier and upgraded-tier access. Rate limiting and audit logging run behind the scenes.

Run it locally with:

```bash
npm install
npm run test
npm run dev
```

Then open [http://127.0.0.1:3000](http://127.0.0.1:3000).

## Notes

The MVP uses shared-secret JWT verification. That is the right tradeoff for the first implementation and for tightly controlled setups, but it is not the long-term production shape. For production, move JWT verification to an asymmetric model so OpenGate verifies with a public key instead of sharing the signing secret.

The current MVP is intentionally narrow: Fastify-first integration, in-memory rate limiting by default, SQLite audit logging, and no distributed rate-limit backend yet.

## Versioning

OpenGate follows semantic versioning. Release versions are generated from conventional commits through `semantic-release`, and the release workflow runs on pushes to `main`.

In practice:
- `fix:` becomes a patch release
- `feat:` becomes a minor release
- breaking changes become a major release

## License

MIT
