import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildUpstreamUrl,
  filterRequestHeaders,
  filterResponseHeaders,
  isPrivateNetworkAddress,
  mapProxyError,
  proxyRequest,
  validateUpstreamUrl,
} from '../../src/v2/proxy/index.js';

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ server: ReturnType<typeof createServer>; url: URL }> {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  return once(server, 'listening').then(() => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    return { server, url: new URL(`http://127.0.0.1:${address.port}`) };
  });
}

describe('v2 proxy URL and header safety', () => {
  it('rejects unsafe upstream targets by default and allows local development explicitly', () => {
    expect(() => validateUpstreamUrl('http://127.0.0.1:8080')).toThrow();
    expect(() => validateUpstreamUrl('https://user:pass@example.com')).toThrow();
    expect(validateUpstreamUrl('http://127.0.0.1:8080', { production: false, allowPrivateNetworks: true }).hostname).toBe('127.0.0.1');
    expect(isPrivateNetworkAddress('10.0.0.1')).toBe(true);
    expect(isPrivateNetworkAddress('::1')).toBe(true);
  });

  it('joins only a relative suffix and preserves query parameters', () => {
    expect(buildUpstreamUrl('https://example.com/root/', '/reports/today', { query: 'a=1&b=2' }).toString()).toBe('https://example.com/root/reports/today?a=1&b=2');
    expect(() => buildUpstreamUrl('https://example.com/root', 'https://evil.example/')).toThrow();
    expect(() => buildUpstreamUrl('https://example.com/root', '/%2e%2e/admin')).toThrow();
  });

  it('strips gateway, forwarding, and hop-by-hop request headers', () => {
    const headers = filterRequestHeaders({
      Host: 'gateway.example',
      Connection: 'keep-alive, X-Secret-Hop',
      'X-Secret-Hop': 'yes',
      'X-OpenGate-Key': 'ogk_secret',
      'X-Forwarded-For': 'spoofed',
      Authorization: 'Bearer upstream-token',
      'Content-Type': 'application/json',
    });
    expect(headers).not.toHaveProperty('Host');
    expect(headers).not.toHaveProperty('X-Secret-Hop');
    expect(headers).not.toHaveProperty('X-OpenGate-Key');
    expect(headers).not.toHaveProperty('X-Forwarded-For');
    expect(headers.Authorization).toBe('Bearer upstream-token');
    expect(filterResponseHeaders({ Connection: 'close', 'X-OpenGate-Key': 'secret', 'Set-Cookie': ['a=1', 'b=2'] })['Set-Cookie']).toEqual(['a=1', 'b=2']);
  });
});

describe('v2 streaming proxy', () => {
  it('forwards method, body, query, and safe headers without buffering', async () => {
    const upstream = await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        response.setHeader('X-Upstream', 'yes');
        response.end(JSON.stringify({ method: request.method, url: request.url, body: Buffer.concat(chunks).toString(), key: request.headers['x-opengate-key'] ?? null }));
      });
    });
    const result = await proxyRequest({
      url: new URL('/v1/items?a=1', upstream.url),
      method: 'POST',
      headers: { 'X-OpenGate-Key': 'secret', 'Content-Type': 'text/plain' },
      body: Readable.from(['hello', ' world']),
    });
    const body = await new Promise<string>((resolve, reject) => { const chunks: Buffer[] = []; result.body.on('data', (c) => chunks.push(Buffer.from(c))); result.body.once('end', () => resolve(Buffer.concat(chunks).toString())); result.body.once('error', reject); });
    expect(result.statusCode).toBe(200);
    expect(result.headers['x-upstream']).toBe('yes');
    expect(JSON.parse(body)).toEqual({ method: 'POST', url: '/v1/items?a=1', body: 'hello world', key: null });
  });

  it('maps unavailable and timeout errors to the public gateway contract', () => {
    expect(mapProxyError(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))).toEqual({ statusCode: 502, body: { error: 'upstream unavailable' } });
    expect(mapProxyError(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))).toEqual({ statusCode: 504, body: { error: 'upstream timeout' } });
  });
});

