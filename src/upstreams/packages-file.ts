import { CapabilityError } from '../errors';
import type { Deps } from '../core/deps';
import type { UpstreamCache } from './cache';
import { fetchUpstream, type Upstream, type UpstreamResponseMeta } from './http';

export interface PackageList {
  response: UpstreamResponseMeta; // for sourceFor(); the body is dropped once parsed
  names: ReadonlySet<string>;
}

/** The value of every `Package:` line (at line start), as a Set. Accepts \n and \r\n. */
export function parsePackagesFileNames(body: string): Set<string> {
  const names = new Set<string>();
  for (const match of body.matchAll(/^Package:[ \t]*(\S+)[ \t]*\r?$/gm)) names.add(match[1]!);
  return names;
}

// The parsed list lives as long as the cache in front of it (a fresh cache gets a fresh memo), so
// a Worker isolate parses each file at most once per TTL. In-flight loads are not shared: these
// files are fetched at most once per TTL per isolate, so two concurrent cold calls each load.
const parsedLists = new WeakMap<UpstreamCache, Map<string, { expiresAt: number; list: PackageList }>>();

/**
 * GET `path` on `upstream` through fetchUpstream, parsed with parsePackagesFileNames and memoized
 * per cache and URL until the response's fetchedAt + upstream.ttlSeconds.
 */
export async function getPackageList(deps: Deps, upstream: Upstream, path: string): Promise<PackageList> {
  const url = new URL(path, upstream.baseUrl).href;
  let byUrl = parsedLists.get(deps.cache);
  if (!byUrl) {
    byUrl = new Map();
    parsedLists.set(deps.cache, byUrl);
  }
  const memo = byUrl.get(url);
  if (memo && deps.now().getTime() < memo.expiresAt) {
    return { names: memo.list.names, response: { ...memo.list.response, fromCache: true } };
  }

  const details = { upstream: upstream.id, url };
  let response: Awaited<ReturnType<typeof fetchUpstream>>;
  try {
    response = await fetchUpstream(deps, upstream, path);
  } catch (error) {
    if (error instanceof CapabilityError && error.code === 'not_found') {
      throw new CapabilityError('upstream_error', `${upstream.name} has no PACKAGES file at ${url}`, details);
    }
    throw error;
  }
  const names = parsePackagesFileNames(response.body);
  // An empty or truncated list would report every CRAN dependency as missing.
  if (names.size === 0) {
    throw new CapabilityError(
      'upstream_error',
      `${upstream.name} returned a PACKAGES file with no packages (${url})`,
      details,
    );
  }
  const { body: _body, ...meta } = response;
  const list: PackageList = { response: meta, names };
  byUrl.set(url, { expiresAt: Date.parse(response.fetchedAt) + upstream.ttlSeconds * 1000, list });
  return list;
}
