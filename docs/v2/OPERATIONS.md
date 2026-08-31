# OpenGate v2 Operations

## First deployment

1. Generate two different random secrets of at least 32 characters: `OPENGATE_KEY_PEPPER` and `OPENGATE_SESSION_SECRET`.
2. Set `OPENGATE_DATABASE_URL` to a durable local SQLite path.
3. Set `OPENGATE_PUBLIC_BASE_URL` to the gateway's public HTTPS URL in production.
4. Run `opengate migrate`.
5. Run `opengate bootstrap-admin --email <email>` and enter the password at the prompt.
6. Start `opengate serve` behind a TLS-terminating reverse proxy, or terminate TLS at OpenGate in a future deployment layer.
7. Open `/admin`, create APIs, roles, consumers, assignments, and keys.

Use a single OpenGate process with SQLite. Running multiple gateway processes against the same SQLite file does not provide a supported distributed quota guarantee.

## Backup and restore

The SQLite database contains all administrator accounts, consumer/key metadata, API/role configuration, assignments, counters, and audit records. It never contains raw consumer API keys.

For a consistent backup, stop the gateway briefly and copy the database file and its `-wal`/`-shm` companions if present. Restore them together to the configured database path, then run `opengate migrate` before serving traffic.

Keep the key pepper and session secret in a secrets manager or equivalent secure deployment configuration. A database backup alone is not enough to verify existing API keys. Rotating the key pepper invalidates all current consumer keys, so schedule it as a coordinated key rotation.

## Key lifecycle

- Issue a new key through the consumer's key workflow; the raw value is shown once.
- Deliver it by a secure channel.
- Confirm the consumer has switched to the new key.
- Revoke the old key.

Never put consumer API keys in URLs, browser JavaScript, source control, logs, or support tickets.

## Health and troubleshooting

- `GET /healthz` shows that the process is alive.
- `GET /readyz` verifies SQLite connectivity and schema version.
- `GET /metrics` returns gateway counters when metrics are enabled.
- The setup page is at `/admin`; its JSON API is under `/admin/api`.

Request outcomes are written to `audit_events`. Filter them in the admin audit API by API, consumer, outcome, or request ID. An `unauthorized` response means the key cannot be verified; `forbidden` means a valid consumer lacks a usable assignment or permission; `rate limited` means either the role's burst limit or its calendar quota is exhausted.

## Production restrictions

Production configuration requires an HTTPS public URL. OpenGate rejects upstream targets that are not HTTPS, include credentials, resolve to private/link-local addresses, or are otherwise unsuitable proxy destinations. This prevents a configured upstream from being used as an SSRF escape hatch.

If an upstream is intentionally inside a private network, place a controlled proxy/network boundary in front of it or add an explicit allowlist design before enabling that route. Do not globally weaken upstream validation.
