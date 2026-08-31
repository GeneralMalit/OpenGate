import { request as httpRequest, type IncomingHttpHeaders, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable, Transform, type Writable } from 'node:stream';
import type { LookupFunction } from 'node:net';
import { filterRequestHeaders, filterResponseHeaders, type HeaderInput } from './headers.js';

export type ProxyErrorKind = 'timeout' | 'unavailable' | 'response_too_large' | 'request_too_large' | 'invalid';

export class UpstreamProxyError extends Error {
  readonly code: string;
  readonly kind: ProxyErrorKind;
  readonly statusCode: number;

  constructor(kind: ProxyErrorKind, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'UpstreamProxyError';
    this.kind = kind;
    this.code = `ERR_UPSTREAM_${kind.toUpperCase()}`;
    this.statusCode = kind === 'timeout' ? 504 : kind === 'invalid' ? 400 : 502;
  }
}

export interface ProxyRequestOptions {
  url: URL | string;
  method?: string;
  headers?: HeaderInput;
  body?: Readable | Buffer | string | null;
  /** Maximum request body accepted by this proxy call. */
  maxRequestBytes?: number;
  /** Maximum streamed response body accepted by this proxy call. */
  maxResponseBytes?: number;
  connectTimeoutMs?: number;
  headersTimeoutMs?: number;
  responseTimeoutMs?: number;
  signal?: AbortSignal;
  /** Used only when a DNS lookup was already validated and pinned. */
  lookup?: LookupFunction;
  agent?: RequestOptions['agent'];
  credentialHeader?: string;
}

export interface ProxyResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  /** A live response stream. Reading it starts consumption; it is never buffered. */
  body: Readable;
  upstreamUrl: URL;
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return value === undefined ? fallback : Math.max(1, Math.floor(value));
}

function isTimeoutLike(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : '';
  const name = error instanceof Error ? error.name : '';
  return code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || name === 'TimeoutError' || name === 'AbortError';
}

function mapNodeError(error: unknown, phase: 'connect' | 'headers' | 'response' = 'connect'): UpstreamProxyError {
  if (error instanceof UpstreamProxyError) return error;
  if (isTimeoutLike(error)) return new UpstreamProxyError('timeout', `upstream ${phase} timed out`, error);
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : '';
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'EPIPE'].includes(code)) {
    return new UpstreamProxyError('unavailable', 'upstream unavailable', error);
  }
  return new UpstreamProxyError('unavailable', 'upstream unavailable', error);
}

function limitedStream(stream: Readable, maxBytes: number | undefined, kind: 'request_too_large' | 'response_too_large'): Readable {
  if (maxBytes === undefined) return stream;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('byte limits must be non-negative safe integers');
  let total = 0;
  const limiter = new Transform({
    transform(chunk: Buffer | string, _encoding, callback) {
      const length = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
      total += length;
      if (total > maxBytes) {
        const error = new UpstreamProxyError(kind, kind === 'request_too_large' ? 'upstream request body is too large' : 'upstream response body is too large');
        stream.destroy(error);
        callback(error);
        return;
      }
      callback(null, chunk);
    },
  });
  stream.once('error', (error) => {
    limiter.destroy(kind === 'response_too_large' ? mapNodeError(error, 'response') : error);
  });
  stream.pipe(limiter);
  return limiter;
}

function nodeHeaders(input: HeaderInput | undefined, credentialHeader?: string): Record<string, string | string[]> {
  const filtered = filterRequestHeaders(input ?? {}, { credentialHeader });
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(filtered)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) result[name] = value.map(String);
    else result[name] = String(value);
  }
  return result;
}

/**
 * Forward one request using node:http(s). Request and response bodies remain
 * streams, so OpenGate does not buffer potentially unbounded payloads.
 */
export function proxyRequest(options: ProxyRequestOptions): Promise<ProxyResponse> {
  let url: URL;
  try { url = new URL(options.url); } catch (error) { return Promise.reject(new UpstreamProxyError('invalid', 'upstream URL is invalid', error)); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return Promise.reject(new UpstreamProxyError('invalid', 'upstream URL protocol is unsupported'));

  const method = (options.method ?? 'GET').toUpperCase();
  const headers = nodeHeaders(options.headers, options.credentialHeader);
  const timeout = positiveTimeout(options.connectTimeoutMs, 10_000);
  const headersTimeout = positiveTimeout(options.headersTimeoutMs, 10_000);
  const responseTimeout = positiveTimeout(options.responseTimeoutMs, 30_000);

  return new Promise<ProxyResponse>((resolve, reject) => {
    let settled = false;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let headersTimer: ReturnType<typeof setTimeout> | undefined;
    let request: ReturnType<typeof httpRequest>;
    const clearTimers = () => {
      if (connectTimer) clearTimeout(connectTimer);
      if (headersTimer) clearTimeout(headersTimer);
      connectTimer = undefined;
      headersTimer = undefined;
    };
    const fail = (error: unknown, phase: 'connect' | 'headers' | 'response' = 'connect') => {
      clearTimers();
      const mapped = mapNodeError(error, phase);
      if (!settled) { settled = true; reject(mapped); }
    };
    const onAbort = () => {
      const error = new UpstreamProxyError('timeout', 'upstream request aborted');
      request.destroy(error);
      fail(error);
    };

    const requestOptions: RequestOptions = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname || '/'}${url.search}`,
      method,
      headers,
      agent: options.agent,
      lookup: options.lookup,
    };
    try {
      request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(requestOptions, (response) => {
        if (settled) return;
        clearTimers();
        const limited = limitedStream(response, options.maxResponseBytes, 'response_too_large');
        const responseTimer = setTimeout(() => {
          const error = new UpstreamProxyError('timeout', 'upstream response timed out');
          response.destroy(error);
          limited.destroy(error);
        }, responseTimeout);
        const clearResponseTimer = () => clearTimeout(responseTimer);
        response.once('end', clearResponseTimer);
        response.once('close', clearResponseTimer);
        limited.once('close', clearResponseTimer);
        settled = true;
        resolve({ statusCode: response.statusCode ?? 502, headers: filterResponseHeaders(response.headers) as IncomingHttpHeaders, body: limited, upstreamUrl: url });
      });
    } catch (error) {
      fail(error);
      return;
    }
    connectTimer = setTimeout(() => request.destroy(new UpstreamProxyError('timeout', 'upstream connection timed out')), timeout);
    headersTimer = setTimeout(() => request.destroy(new UpstreamProxyError('timeout', 'upstream response headers timed out')), headersTimeout);
    request.once('socket', (socket) => {
      if (!socket.connecting) { if (connectTimer) clearTimeout(connectTimer); connectTimer = undefined; return; }
      socket.once('connect', () => { if (connectTimer) clearTimeout(connectTimer); connectTimer = undefined; });
      socket.once('secureConnect', () => { if (connectTimer) clearTimeout(connectTimer); connectTimer = undefined; });
    });
    request.once('response', () => { if (headersTimer) clearTimeout(headersTimer); headersTimer = undefined; });
    request.once('error', (error) => fail(error, 'connect'));
    if (options.signal) {
      if (options.signal.aborted) { onAbort(); return; }
      options.signal.addEventListener('abort', onAbort, { once: true });
      request.once('close', () => options.signal?.removeEventListener('abort', onAbort));
    }

    try {
      if (options.body === null || options.body === undefined) request.end();
      else if (Buffer.isBuffer(options.body) || typeof options.body === 'string') {
        if (options.maxRequestBytes !== undefined && Buffer.byteLength(options.body) > options.maxRequestBytes) {
          request.destroy(new UpstreamProxyError('request_too_large', 'upstream request body is too large'));
          fail(new UpstreamProxyError('request_too_large', 'upstream request body is too large'));
          return;
        }
        request.end(options.body);
      } else {
        const requestBody = limitedStream(options.body, options.maxRequestBytes, 'request_too_large');
        requestBody.once('error', (error) => {
          request.destroy(error);
          fail(error);
        });
        requestBody.pipe(request);
      }
    } catch (error) { fail(error); }
  });
}

/** Pipe a proxy response to a node HTTP/Fastify raw response. */
export function streamProxyResponse(response: ProxyResponse, target: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    for (const [name, value] of Object.entries(response.headers)) {
      if (value !== undefined && typeof (target as Writable & { setHeader?: unknown }).setHeader === 'function') {
        (target as Writable & { setHeader(name: string, value: string | string[]): void }).setHeader(name, value as string | string[]);
      }
    }
    response.body.once('error', reject);
    target.once('error', reject);
    target.once('finish', () => resolve());
    response.body.pipe(target);
  });
}

export function mapProxyError(error: unknown): { statusCode: number; body: { error: string } } {
  const mapped = error instanceof UpstreamProxyError ? error : mapNodeError(error);
  if (mapped.kind === 'timeout') return { statusCode: 504, body: { error: 'upstream timeout' } };
  if (mapped.kind === 'invalid') return { statusCode: 400, body: { error: 'invalid upstream' } };
  if (mapped.kind === 'request_too_large' || mapped.kind === 'response_too_large') return { statusCode: 502, body: { error: 'upstream unavailable' } };
  return { statusCode: 502, body: { error: 'upstream unavailable' } };
}
