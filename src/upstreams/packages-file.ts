import { CapabilityError } from '../errors';
import type { Deps } from '../core/deps';
import { fetchUpstream, type Upstream, type UpstreamResponseMeta } from './http';
import { SharedLoads } from './shared-load';

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

const packageLists = new SharedLoads<PackageList>();

/**
 * GET `path` on `upstream` through fetchUpstream, parsed with parsePackagesFileNames and memoized
 * per cache and URL until the response's fetchedAt + upstream.ttlSeconds. Concurrent callers on a
 * cold or expired entry share one load (SharedLoads).
 */
export async function getPackageList(deps: Deps, upstream: Upstream, path: string): Promise<PackageList> {
  const url = new URL(path, upstream.baseUrl).href;
  return packageLists.get(deps, upstream, url, 'the PACKAGES file', () => loadPackageList(deps, upstream, path, url));
}

async function loadPackageList(deps: Deps, upstream: Upstream, path: string, url: string): Promise<PackageList> {
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
  return { response: meta, names };
}
