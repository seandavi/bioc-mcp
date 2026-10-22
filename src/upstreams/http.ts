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

export interface UpstreamResponse extends CachedUpstream {
  fromCache: boolean;
}

/** GET `path` relative to upstream.baseUrl, through the cache. */
export async function fetchUpstream(deps: Deps, upstream: Upstream, path: string): Promise<UpstreamResponse> {
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
  let response: Response;
  try {
    response = await deps.fetch(
      new Request(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) }),
    );
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new CapabilityError('upstream_timeout', `${upstream.name} did not answer within ${timeoutMs} ms`, details);
    }
    throw new CapabilityError('upstream_error', `Could not reach ${upstream.name}`, details);
  }

  // Redirects are followed, so the final URL must also stay inside the upstream.
  if (response.url && !inside(new URL(response.url))) {
    throw new CapabilityError('upstream_error', `${upstream.name} redirected outside its base URL`, details);
  }

  if (response.status === 404) {
    throw new CapabilityError('not_found', `${upstream.name} has nothing at ${url.href}`, {
      ...details,
      status: 404,
    });
  }
  if (!response.ok) {
    throw new CapabilityError('upstream_error', `${upstream.name} returned HTTP ${response.status}`, {
      ...details,
      status: response.status,
    });
  }

  let body: string;
  try {
    body = await response.text();
  } catch {
    throw new CapabilityError('upstream_error', `Could not read the response from ${upstream.name}`, details);
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
