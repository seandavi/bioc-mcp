import { CapabilityError } from '../errors';
import type { Source } from '../envelope';
import type { Deps } from '../core/deps';
import { VERSION } from '../version';
import type { CachedUpstream } from './cache';

export interface Upstream {
  id: string; // stable, kebab-case, e.g. 'registry', 'r-universe'
  name: string; // human name used in messages, e.g. 'Bioconductor registry'
  baseUrl: string; // https:, no credentials, ends with '/', no query/fragment
  ttlSeconds: number; // positive integer; cache TTL for 200 responses
  timeoutMs?: number; // positive integer <= MAX_TIMEOUT_MS; default DEFAULT_TIMEOUT_MS
  maxBytes?: number; // positive integer; decoded body bytes read before failing; default DEFAULT_MAX_BYTES. Peak memory per read is about 2x this plus the parsed JSON (see readCapped)
  description: string; // one line for bioc://about
}

export const DEFAULT_TIMEOUT_MS = 10_000;
/** AbortSignal.timeout needs an integer delay; a minute is far above any upstream we call. */
export const MAX_TIMEOUT_MS = 60_000;
/** 2 MiB: more than 10x the largest github, r-universe or bioconductor.org response seen. */
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
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
    throw new CapabilityError('invalid_input', `"${value}" cannot be used as a URL path segment.`);
  }
  return encodeURIComponent(value);
}

export interface UpstreamResponse extends CachedUpstream {
  fromCache: boolean;
}

/** An UpstreamResponse without its body: what a caller keeps for provenance after parsing. */
export type UpstreamResponseMeta = Omit<UpstreamResponse, 'body'>;

/**
 * The SSRF guard below is only sound for an https: baseUrl that ends with '/' and has no query or
 * fragment. The baseUrl must not carry credentials. No message ever includes the baseUrl itself,
 * so a password in a malformed or non-https: URL never reaches a client. ttlSeconds must be a
 * positive integer (about and cache-control take integers). timeoutMs, when set, must be a
 * positive integer no greater than MAX_TIMEOUT_MS (AbortSignal.timeout throws on fractions and
 * on values above 2^32 - 1). maxBytes, when set, must be a positive integer. Checked at
 * registration (validateRegistry) and again on every fetch, so an adapter cannot bypass it by
 * passing an upstream it never registered.
 */
export function assertUpstream(upstream: Upstream): void {
  const label = `Upstream "${upstream.id}" baseUrl`;
  let url: URL;
  try {
    url = new URL(upstream.baseUrl);
  } catch {
    throw new Error(`${label} is not an absolute URL`);
  }
  if (url.protocol !== 'https:') throw new Error(`${label} must use https:`);
  if (url.username !== '' || url.password !== '') throw new Error(`${label} must not include credentials`);
  if (!url.pathname.endsWith('/')) throw new Error(`${label} must end with "/"`);
  if (url.search !== '' || url.hash !== '') throw new Error(`${label} must not have a query string or fragment`);
  if (!Number.isInteger(upstream.ttlSeconds) || upstream.ttlSeconds <= 0) {
    throw new Error(`Upstream "${upstream.id}" ttlSeconds must be a positive integer (got ${upstream.ttlSeconds})`);
  }
  const { timeoutMs, maxBytes } = upstream;
  if (timeoutMs !== undefined && !(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_TIMEOUT_MS)) {
    throw new Error(
      `Upstream "${upstream.id}" timeoutMs must be a positive integer no greater than ${MAX_TIMEOUT_MS} (got ${timeoutMs})`,
    );
  }
  if (maxBytes !== undefined && !(Number.isInteger(maxBytes) && maxBytes > 0)) {
    throw new Error(`Upstream "${upstream.id}" maxBytes must be a positive integer (got ${maxBytes})`);
  }
}

/** AbortSignal.timeout rejects fetch and body reads with TimeoutError (AbortError in some runtimes). */
function isTimeout(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  return name === 'TimeoutError' || name === 'AbortError';
}

/**
 * The body as UTF-8 text, like response.text(), or null once more than maxBytes have arrived. The
 * count is of decoded bytes (after Content-Encoding). Past the cap the stream is cancelled, so its
 * connection is released and nothing more is buffered. Read errors (including the timeout)
 * propagate to the caller.
 *
 * Memory: the decoded chunks in `parts` and the joined string coexist until join returns, and the
 * count is checked after a chunk arrives, so one read peaks at about 2 × maxBytes plus one chunk
 * (for ASCII bodies; V8 holds text outside Latin-1 at 2 bytes per character).
 * fetchUpstreamJson then holds the parsed value while the body string is still referenced.
 * Choose per-upstream caps on that basis: the 16 MiB registry and CRAN caps allow about 32 MB of
 * strings per uncached read on a 128 MB isolate.
 */
async function readCapped(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string | null> {
  if (body === null) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(decoder.decode(value, { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join('');
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
    throw new CapabilityError('internal', `Refusing to fetch outside ${upstream.name}.`, { upstream: upstream.id });
  }

  const hit = await deps.cache.get(url.href);
  if (hit) return { ...hit, fromCache: true };

  const timeoutMs = upstream.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = upstream.maxBytes ?? DEFAULT_MAX_BYTES;
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
      throw new CapabilityError('upstream_error', `${upstream.name} redirected outside its base URL.`, details);
    }
    if (hops >= MAX_REDIRECTS) {
      throw new CapabilityError('upstream_error', `${upstream.name} redirected more than ${MAX_REDIRECTS} times.`, details);
    }
    target = next;
  }

  if (response.status === 404) {
    throw new CapabilityError('not_found', `${upstream.name} has nothing at ${url.href}.`, {
      ...details,
      status: 404,
    });
  }
  if (!response.ok) {
    const advice = response.status >= 500 ? ` (${url.href}). ${RETRY}` : '';
    throw new CapabilityError('upstream_error', `${upstream.name} returned HTTP ${response.status}${advice || '.'}`, {
      ...details,
      status: response.status,
    });
  }

  let body: string | null;
  try {
    body = await readCapped(response.body, maxBytes);
  } catch (error) {
    if (isTimeout(error)) throw timeoutError();
    throw new CapabilityError(
      'upstream_error',
      `Could not read the response from ${upstream.name} (${url.href}). ${RETRY}`,
      details,
    );
  }
  if (body === null) {
    throw new CapabilityError(
      'upstream_error',
      `${upstream.name} sent more than ${maxBytes} bytes (${url.href}); this server does not read responses that large.`,
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
    throw new CapabilityError('upstream_error', `${upstream.name} returned a response that is not valid JSON.`, {
      upstream: upstream.id,
      url: response.url,
    });
  }
}

/** Provenance for one response: as_of = asOf ?? response.lastModified ?? response.fetchedAt. */
export function sourceFor(response: UpstreamResponseMeta, asOf?: string): Source {
  return { url: response.url, as_of: asOf ?? response.lastModified ?? response.fetchedAt };
}
