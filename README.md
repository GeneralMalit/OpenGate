# OpenGate

OpenGate is an open-source, zero-trust API gateway designed to be a **drop-in security and policy layer** for any HTTP API. You place OpenGate in front of an existing service, and it becomes the single entry point for all consumers. Every request is authenticated, policy-checked, rate-limited, and audited before it ever touches the upstream API.

## Overview

**What it is**
- A lightweight gateway that sits between **API providers** and **API consumers**
- A security and governance layer that requires **no changes** to upstream services
- A practical alternative to heavy API management platforms for small teams and startups

**What it solves**
- Prevents abuse and accidental overload through rate limiting
- Enforces per-route authorization using scopes
- Provides a clear audit trail of who called what, when, and how often
- Makes external API exposure safer without rewriting existing services

**How it works (request flow)**
1) Client sends a request to OpenGate  
2) OpenGate validates the API key from a configurable header  
3) It checks IP policy rules (optional)  
4) It applies rate limits per key  
5) It enforces scope requirements based on the route path  
6) It proxies the request to the upstream API  
7) It logs the request and outcome in the audit store  

**Who it is for**
- Teams that want to expose or partner-enable APIs safely
- Builders who need a minimal integration point for security controls
- Developers who want an open, auditable gateway without vendor lock-in

## Quick start

1) Install dependencies
```
npm install
```

2) Run the mock upstream
```
npm run demo:upstream
```

3) Start OpenGate
```
npm run dev
```

4) Call the gateway
```
curl -H "x-api-key: demo-key" http://localhost:8080/v1/payments
```

## Configuration

OpenGate loads `opengate.config.json` by default. Override with:
```
OPENGATE_CONFIG=path/to/config.json npm run dev
```

### Key settings
- `upstream.url`: target API to protect
- `auth.header`: header used for API keys
- `auth.keys`: allowed keys and scopes
- `rate_limit`: requests per duration
- `routes`: path-based scope rules
- `audit.db_path`: SQLite file for audit logs
- `policies.allowed_ips`: optional IP allow list

## Design goals
- **Drop-in**: no upstream code changes
- **Zero trust**: every request is authenticated and policy-checked
- **Audit-ready**: immutable request logs
- **Open source**: MIT license

## JWT Note
The MVP is planned to support JWT verification using a shared secret so the first implementation stays simple and easy to validate. For production-oriented usage, the project direction is to move toward asymmetric JWT verification so verification keys can be distributed without sharing signing power.

## License
MIT
