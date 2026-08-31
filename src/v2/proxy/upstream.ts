import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';

export interface UpstreamValidationOptions {
  /** Production mode requires HTTPS and disallows private/link-local targets. */
  production?: boolean;
  requireHttps?: boolean;
  allowPrivateNetworks?: boolean;
  allowedHosts?: readonly string[];
}

export class UpstreamConfigurationError extends Error {
  readonly code = 'ERR_INVALID_UPSTREAM_URL';

  constructor(message: string) {
    super(message);
    this.name = 'UpstreamConfigurationError';
  }
}

function normalizeHost(host: string): string {
  return host.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
}

function isPrivateIpv4(host: string): boolean {
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(host: string): boolean {
  const normalized = normalizeHost(host);
  if (normalized === '::1' || normalized === '::' || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true;
  // Unique-local fc00::/7 and IPv4-mapped private addresses.
  if (/^f[cd]/i.test(normalized)) return true;
  const mapped = normalized.match(/(?:^|:)ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return Boolean(mapped && isPrivateIpv4(mapped[1]));
}

export function isPrivateNetworkAddress(host: string): boolean {
  const normalized = normalizeHost(host);
  const kind = isIP(normalized);
  return kind === 4 ? isPrivateIpv4(normalized) : kind === 6 ? isPrivateIpv6(normalized) : false;
}

function hostAllowed(host: string, allowedHosts: readonly string[]): boolean {
  const normalized = normalizeHost(host);
  return allowedHosts.some((entry) => {
    const allowed = normalizeHost(entry);
    if (allowed.startsWith('*.')) return normalized.endsWith(allowed.slice(1)) && normalized !== allowed.slice(2);
    return normalized === allowed;
  });
}

/** Validate a registered base URL. It does not perform DNS lookups. */
export function validateUpstreamUrl(input: string | URL, options: UpstreamValidationOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UpstreamConfigurationError('upstream URL must be absolute');
  }
  const production = options.production ?? true;
  const requireHttps = options.requireHttps ?? production;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UpstreamConfigurationError('upstream URL protocol must be http or https');
  }
  if (requireHttps && url.protocol !== 'https:') {
    throw new UpstreamConfigurationError('HTTPS is required for upstream URLs in production');
  }
  if (url.username || url.password) throw new UpstreamConfigurationError('upstream URL must not contain credentials');
  if (url.hash) throw new UpstreamConfigurationError('upstream URL must not contain a fragment');
  if (url.search) throw new UpstreamConfigurationError('upstream URL must not contain a query string');
  const host = normalizeHost(url.hostname);
  if (!host || ((!options.allowPrivateNetworks) && (host === 'localhost' || host.endsWith('.localhost') || host === 'local'))) {
    throw new UpstreamConfigurationError('local upstream hosts are not allowed');
  }
  if (options.allowedHosts && !hostAllowed(host, options.allowedHosts)) {
    throw new UpstreamConfigurationError('upstream host is not in the configured allowlist');
  }
  if (!options.allowPrivateNetworks && isPrivateNetworkAddress(host)) {
    throw new UpstreamConfigurationError('private or link-local upstream addresses are not allowed');
  }
  return new URL(url.toString());
}

export function assertSafeUpstreamUrl(input: string | URL, options?: UpstreamValidationOptions): URL {
  return validateUpstreamUrl(input, options);
}

export interface ResolvedUpstream {
  url: URL;
  addresses: string[];
}

/**
 * Validate the DNS answer as well as the URL. The returned addresses can be
 * pinned in proxyRequest, preventing a DNS-rebinding change between validation
 * and connection.
 */
export async function resolveSafeUpstreamUrl(input: string | URL, options: UpstreamValidationOptions = {}): Promise<ResolvedUpstream> {
  const url = validateUpstreamUrl(input, options);
  const host = normalizeHost(url.hostname);
  if (isIP(host)) return { url, addresses: [host] };
  let records: Array<{ address: string }>;
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new UpstreamConfigurationError('upstream hostname could not be resolved');
  }
  const addresses = records.map((record) => record.address);
  if (!addresses.length) throw new UpstreamConfigurationError('upstream hostname has no addresses');
  if (!(options.allowPrivateNetworks ?? false) && addresses.some(isPrivateNetworkAddress)) {
    throw new UpstreamConfigurationError('upstream hostname resolves to a private or link-local address');
  }
  return { url, addresses };
}

/** Create a node:http lookup callback pinned to the addresses already checked above. */
export function createPinnedLookup(addresses: readonly string[]): LookupFunction {
  const safe = [...addresses];
  if (!safe.length) throw new UpstreamConfigurationError('at least one pinned upstream address is required');
  let next = 0;
  return (_hostname, options, callback) => {
    const address = safe[next++ % safe.length];
    const family = isIP(address) as 4 | 6;
    if (options && typeof options === 'object' && 'all' in options && options.all) {
      callback(null, [{ address, family }]);
    } else {
      callback(null, address, family);
    }
  };
}

export interface BuildUpstreamUrlOptions {
  query?: string | URLSearchParams;
  validation?: UpstreamValidationOptions;
}

function validateSuffix(suffix: string): string {
  if (/[\u0000-\u0020\\#]/.test(suffix)) throw new UpstreamConfigurationError('upstream path contains unsafe characters');
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(suffix) || suffix.startsWith('//')) {
    throw new UpstreamConfigurationError('upstream path must be relative');
  }
  const pathOnly = suffix.split('?', 1)[0];
  for (const segment of pathOnly.split('/')) {
    let decoded: string;
    try { decoded = decodeURIComponent(segment); } catch { throw new UpstreamConfigurationError('upstream path contains malformed encoding'); }
    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) {
      throw new UpstreamConfigurationError('upstream path traversal is not allowed');
    }
  }
  return suffix;
}

/** Join a registered base path and a route suffix without allowing destination changes. */
export function buildUpstreamUrl(base: string | URL, suffix = '/', options: BuildUpstreamUrlOptions = {}): URL {
  const baseUrl = validateUpstreamUrl(base, options.validation);
  const safeSuffix = validateSuffix(suffix || '/');
  const [suffixPath, suffixQuery] = safeSuffix.split(/\?(.*)/s, 2);
  const prefix = baseUrl.pathname.replace(/\/+$/, '');
  const tail = `/${(suffixPath || '/').replace(/^\/+/, '')}`;
  const result = new URL(baseUrl.origin + (prefix || '') + (tail === '/' && prefix ? '/' : tail));
  const query = options.query === undefined ? suffixQuery : options.query.toString();
  if (query) result.search = query.startsWith('?') ? query : `?${query}`;
  return result;
}
