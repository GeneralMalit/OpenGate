import Fastify from "fastify";
import proxy from "@fastify/http-proxy";
import { loadConfig } from "./lib/config.js";
import { createRateLimiter } from "./lib/rate_limit.js";
import { createAuditLogger } from "./lib/audit.js";
import { getApiKey, hasScopes } from "./lib/keys.js";
import { ipAllowed, requiredScopesForPath } from "./lib/policies.js";

const config = loadConfig();
const app = Fastify({ logger: true });
const limiter = createRateLimiter(config);
const auditLogger = createAuditLogger(config);

app.decorateRequest("opengateStart", null);
app.decorateRequest("opengateKey", null);
app.decorateRequest("opengateClient", null);

app.addHook("onRequest", async (request, reply) => {
  const clientIp = request.ip;
  if (!ipAllowed(config, clientIp)) {
    reply.code(403).send({ error: "IP not allowed" });
    return;
  }

  request.opengateStart = process.hrtime.bigint();

  const apiKey = request.headers[config.auth.header] as string | undefined;
  const keyRecord = getApiKey(config, apiKey);

  if (!keyRecord) {
    reply.code(401).send({ error: "Invalid API key" });
    return;
  }

  const requiredScopes = requiredScopesForPath(config, request.url);
  if (!hasScopes(keyRecord, requiredScopes)) {
    reply.code(403).send({ error: "Insufficient scope" });
    return;
  }

  try {
    await limiter.consume(keyRecord.key);
  } catch {
    reply.code(429).send({ error: "Rate limit exceeded" });
    return;
  }

  request.opengateClient = keyRecord.name;
  request.opengateKey = keyRecord.key;
});

app.addHook("onSend", async (request, reply, payload) => {
  const apiKey = request.opengateKey as string | null;
  const clientName = request.opengateClient as string | null;

  if (!auditLogger || !apiKey || !clientName) {
    return payload;
  }

  const timingMs = request.opengateStart
    ? Number(process.hrtime.bigint() - request.opengateStart) / 1_000_000
    : 0;

  auditLogger.log({
    time: new Date().toISOString(),
    client_name: clientName,
    api_key: apiKey,
    method: request.method,
    path: request.url,
    status_code: reply.statusCode,
    upstream_ms: Math.round(timingMs),
    ip: request.ip ?? null
  });

  return payload;
});

app.register(proxy, {
  upstream: config.upstream.url,
  rewritePrefix: "",
  replyOptions: {
    onError(request, reply, error) {
      request.log.error({ err: error }, "Upstream proxy error");
      reply.code(502).send({ error: "Bad gateway" });
    }
  }
});

app.listen({ host: config.server.host, port: config.server.port })
  .then(() => {
    app.log.info(`OpenGate listening on ${config.server.host}:${config.server.port}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

process.on("SIGINT", () => {
  auditLogger?.close();
  process.exit(0);
});
