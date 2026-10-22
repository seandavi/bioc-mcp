import { CapabilityError } from '../errors';
import type { Source } from '../envelope';
import type { Deps } from '../core/deps';
import { VERSION } from '../version';
import type { CachedUpstream } from './cache';

export interface Upstream {
  id: string; // stable, kebab-case, e.g. 'registry', 'r-universe'
  name: string; // human name used in messages, e.g. 'Bioconductor registry'
  baseUrl: string; // absolute, ends with '/', e.g. 'https://registry.bioconductor.org/'
  ttlSeconds: number; // cache TTL for 200 responses
  timeoutMs?: number; // default DEFAULT_TIMEOUT_MS
  description: string; // one line for bioc://about
}

export const DEFAULT_TIMEOUT_MS = 10_000;
export const USER_AGENT = `bioc-mcp/${VERSION} (+https://github.com/seandavi/bioc-mcp)`;

const MAX_REDIRECTS = 3;
const RETRY = 'Try again shortly.';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function parseLocation(location: string, base: URL): URL | undefined {
  try {
    return new URL(location, base);
  } catch {
    return undefined;
  }
}

/**
 * Encode one caller-supplied value as a single URL path segment.
 *
 * Every adapter must build upstream paths through this helper (`items/${pathSegment(id)}.json`),
 * never by interpolating raw input. It rejects values that could climb out of the segment:
 * '', '.', '..', and anything containing '/', '\\' or an encoded dot or slash (%2e, %2f).
 */
export function pathSegment(value: string): string {
  if (value === '' || value === '.' || value === '..' || /[/\\]|%2e|%2f/i.test(value)) {
    throw new CapabilityError('invalid_input', `"${value}" cannot be used as a URL path segment`);
  }
  return encodeURIComponent(value);
}

export interface UpstreamResponse extends CachedUpstream {
  fromCache: boolean;
}

/**
 * The SSRF guard below is only sound for an https: baseUrl that ends with '/' and has no query or
 * fragment. The baseUrl must not carry credentials (the message leaves the URL out so a password
 * never reaches a client), ttlSeconds must be a positive integer (about and cache-control take
 * integers) and timeoutMs, when set, positive and finite. Checked at registration
 * (validateRegistry) and again on every fetch, so an adapter cannot bypass it by passing an
 * upstream it never registered.
 */
export function assertUpstream(upstream: Upstream): void {
  const label = `Upstream "${upstream.id}" baseUrl "${upstream.baseUrl}"`;
  let url: URL;
  try {
    url = new URL(upstream.baseUrl);
  } catch {
    throw new Error(`${label} is not an absolute URL`);
  }
  if (url.protocol !== 'https:') throw new Error(`${label} must use https:`);
  if (url.username !== '' || url.password !== '') {
    throw new Error(`Upstream "${upstream.id}" baseUrl must not include credentials`);
  }
  if (!url.pathname.endsWith('/')) throw new Error(`${label} must end with "/"`);
  if (url.search !== '' || url.hash !== '') throw new Error(`${label} must not have a query string or fragment`);
  if (!Number.isInteger(upstream.ttlSeconds) || upstream.ttlSeconds <= 0) {
    throw new Error(`Upstream "${upstream.id}" ttlSeconds must be a positive integer (got ${upstream.ttlSeconds})`);
  }
  const { timeoutMs } = upstream;
  if (timeoutMs !== undefined && !(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    throw new Error(`Upstream "${upstream.id}" timeoutMs must be a positive finite number (got ${timeoutMs})`);
  }
}

/** AbortSignal.timeout rejects fetch and body reads with TimeoutError (AbortError in some runtimes). */
function isTimeout(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  return name === 'TimeoutError' || name === 'AbortError';
}

/** GET `path` relative to upstream.baseUrl, through the cache. */
export async function fetchUpstream(deps: Deps, upstream: Upstream, path: string): Promise<UpstreamResponse> {
  try {
    assertUpstream(upstream);
  } catch (error) {
    throw new CapabilityError('internal', (error as Error).message, { upstream: upstream.id });
  }
  const base = new URL(upstream.baseUrl);
  const url = new URL(path, base);
  const inside = (candidate: URL) => candidate.origin === base.origin && candidate.pathname.startsWith(base.pathname);
  // SSRF guard: no capability can fetch outside a registered upstream.
  if (!inside(url)) {
    throw new CapabilityError('internal', `Refusing to fetch outside ${upstream.name}`, { upstream: upstream.id });
  }

  const hit = await deps.cache.get(url.href);
  if (hit) return { ...hit, fromCache: true };

  const timeoutMs = upstream.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const details = { upstream: upstream.id, url: url.href };
  const timeoutError = () =>
    new CapabilityError(
      'upstream_timeout',
      `${upstream.name} did not answer within ${timeoutMs} ms (${url.href}). ${RETRY}`,
      details,
    );
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  let target = url;
  for (let hops = 0; ; hops++) {
    try {
      // Redirects are never followed by the runtime: each hop is re-checked against the base below.
      response = await deps.fetch(
        new Request(target, { headers: { 'user-agent': USER_AGENT }, redirect: 'manual', signal }),
      );
    } catch (error) {
      if (isTimeout(error)) throw timeoutError();
      throw new CapabilityError('upstream_error', `Could not reach ${upstream.name} (${url.href}). ${RETRY}`, details);
    }

    const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get('location') : null;
    if (location === null) break;
    // Release the redirect's connection before following or failing (Workers cap concurrent connections).
    await response.body?.cancel().catch(() => {});
    const next = parseLocation(location, target);
    if (!next || !inside(next)) {
      throw new CapabilityError('upstream_error', `${upstream.name} redirected outside its base URL`, details);
    }
    if (hops >= MAX_REDIRECTS) {
      throw new CapabilityError('upstream_error', `${upstream.name} redirected more than ${MAX_REDIRECTS} times`, details);
    }
    target = next;
  }

  if (response.status === 404) {
    throw new CapabilityError('not_found', `${upstream.name} has nothing at ${url.href}`, {
      ...details,
      status: 404,
    });
  }
  if (!response.ok) {
    const advice = response.status >= 500 ? ` (${url.href}). ${RETRY}` : '';
    throw new CapabilityError('upstream_error', `${upstream.name} returned HTTP ${response.status}${advice}`, {
      ...details,
      status: response.status,
    });
  }

  let body: string;
  try {
    body = await response.text();
  } catch (error) {
    if (isTimeout(error)) throw timeoutError();
    throw new CapabilityError(
      'upstream_error',
      `Could not read the response from ${upstream.name} (${url.href}). ${RETRY}`,
      details,
    );
  }
  const lastModifiedHeader = response.headers.get('last-modified');
  const lastModifiedMs = lastModifiedHeader ? Date.parse(lastModifiedHeader) : Number.NaN;
  const value: CachedUpstream = {
    url: url.href,
    body,
    contentType: response.headers.get('content-type'),
    lastModified: Number.isNaN(lastModifiedMs) ? null : new Date(lastModifiedMs).toISOString(),
    fetchedAt: deps.now().toISOString(),
  };
  if (response.status === 200) await deps.cache.put(url.href, value, upstream.ttlSeconds);
  return { ...value, fromCache: false };
}

/** fetchUpstream + JSON.parse; bad JSON → CapabilityError('upstream_error'). */
export async function fetchUpstreamJson(
  deps: Deps,
  upstream: Upstream,
  path: string,
): Promise<{ response: UpstreamResponse; json: unknown }> {
  const response = await fetchUpstream(deps, upstream, path);
  try {
    return { response, json: JSON.parse(response.body) as unknown };
  } catch {
    throw new CapabilityError('upstream_error', `${upstream.name} returned a response that is not valid JSON`, {
      upstream: upstream.id,
      url: response.url,
    });
  }
}

/** Provenance for one response: as_of = asOf ?? response.lastModified ?? response.fetchedAt. */
export function sourceFor(response: UpstreamResponse, asOf?: string): Source {
  return { url: response.url, as_of: asOf ?? response.lastModified ?? response.fetchedAt };
}
