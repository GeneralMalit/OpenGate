import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';

/** The headers which HTTP/1.1 defines as hop-by-hop headers. */
export const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export type HeaderValue = string | string[] | number | undefined;
export type HeaderInput =
  | Headers
  | IncomingHttpHeaders
  | OutgoingHttpHeaders
  | Record<string, HeaderValue>;

export interface HeaderFilterOptions {
  /** Header carrying the OpenGate credential. It is never sent upstream. */
  credentialHeader?: string;
  /** Additional names to remove, compared case-insensitively. */
  remove?: Iterable<string>;
  /** Keep the Host header (normally it should be generated from the target URL). */
  preserveHost?: boolean;
  /** Keep forwarding headers. Disabled by default so callers cannot spoof client IP. */
  preserveForwardedHeaders?: boolean;
}

const FORWARDING_HEADERS = new Set([
  'forwarded',
  'via',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
  'x-real-ip',
]);

function entries(input: HeaderInput): Iterable<[string, string | string[] | number | undefined]> {
  if (input instanceof Headers) {
    return input.entries();
  }
  return Object.entries(input);
}

function values(value: string | string[] | number | undefined): string | string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return String(value);
  return value;
}

/**
 * Remove headers which must not cross the gateway boundary. The result is a
 * plain object suitable for node:http, and preserves repeated headers such as
 * `set-cookie`.
 */
export function filterHeaders(input: HeaderInput, options: HeaderFilterOptions = {}): OutgoingHttpHeaders {
  const credential = (options.credentialHeader ?? 'x-opengate-key').toLowerCase();
  const remove = new Set(Array.from(options.remove ?? [], (name) => name.toLowerCase()));
  const result: OutgoingHttpHeaders = {};
  const emitted = new Set<string>();

  // Connection can nominate arbitrary additional hop-by-hop header names.
  const nominated = new Set<string>();
  for (const [name, value] of entries(input)) {
    if (name.toLowerCase() !== 'connection' || value === undefined) continue;
    for (const part of Array.isArray(value) ? value : [String(value)]) {
      for (const token of part.split(',')) nominated.add(token.trim().toLowerCase());
    }
  }

  for (const [rawName, rawValue] of entries(input)) {
    const name = rawName.toLowerCase();
    if (rawValue === undefined) continue;
    if (HOP_BY_HOP_HEADERS.has(name) || nominated.has(name)) continue;
    if (name === credential || name === 'x-opengate-key') continue;
    if (!options.preserveHost && name === 'host') continue;
    if (!options.preserveForwardedHeaders && FORWARDING_HEADERS.has(name)) continue;
    if (remove.has(name)) continue;
    // Never forward two differently-cased versions of a header. In addition
    // to being surprising, that can create request-smuggling ambiguity in an
    // upstream with less strict header normalization.
    if (emitted.has(name)) continue;
    emitted.add(name);
    result[rawName] = values(rawValue);
  }
  return result;
}

export function filterRequestHeaders(input: HeaderInput, options?: HeaderFilterOptions): OutgoingHttpHeaders {
  return filterHeaders(input, options);
}

export function filterResponseHeaders(input: HeaderInput, options?: HeaderFilterOptions): OutgoingHttpHeaders {
  // The same hop-by-hop and connection-token filtering applies in both directions.
  // Do not remove Host here: upstream responses cannot normally contain it.
  return filterHeaders(input, { ...options, preserveHost: true, preserveForwardedHeaders: false });
}
