import { CapabilityError } from '../errors';
import type { Deps } from '../core/deps';
import { fetchUpstream, type Upstream, type UpstreamResponseMeta } from './http';
import { PackageNameSchema } from './package-name';
import { SharedLoads } from './shared-load';

export interface PackagesFile {
  response: UpstreamResponseMeta; // for sourceFor(); the body is dropped once parsed
  versions: ReadonlyMap<string, string>; // Package → Version, in order of first appearance
}

// dotAll and no `m` flag: `(.*)` runs to the end of the line and `$` is the end of input, so
// nothing backtracks (a `[ \t]*` before `(.*)` was quadratic on spaces before a lone \r).
const PACKAGES_FIELD = /^([^\s:]+):(.*)$/s;
const PACKAGES_VERSION = /^\d+([.-]\d+)*$/;

/**
 * Package → Version from a PACKAGES (DCF) body, in order of first appearance; throws
 * upstream_error (with `url`) on any deviation. A name may repeat only in stanzas that carry
 * `Path` (CRAN lists each recommended package again under `Path: <R version>/Recommended`).
 */
export function parsePackagesFile(body: string, upstream: Upstream, url: string): Map<string, string> {
  const malformed = () =>
    new CapabilityError(
      'upstream_error',
      `${upstream.name} returned a PACKAGES file in an unexpected format (${url})`,
      { upstream: upstream.id, url },
    );
  const versions = new Map<string, string>();
  const fromPath = new Set<string>(); // names whose current entry came from a `Path` stanza
  let packageNames: string[] = [];
  let packageVersions: string[] = [];
  let hasPath = false;
  let inStanza = false;

  const endStanza = () => {
    if (!inStanza) return;
    const name = packageNames[0];
    const version = packageVersions[0];
    if (
      packageNames.length !== 1 ||
      packageVersions.length !== 1 ||
      name === undefined ||
      version === undefined ||
      !PackageNameSchema.safeParse(name).success ||
      !PACKAGES_VERSION.test(version)
    ) {
      throw malformed();
    }
    if (!versions.has(name)) {
      versions.set(name, version);
      if (hasPath) fromPath.add(name);
    } else if (!hasPath) {
      if (!fromPath.has(name)) throw malformed();
      versions.set(name, version);
      fromPath.delete(name);
    }
    packageNames = [];
    packageVersions = [];
    hasPath = false;
    inStanza = false;
  };

  for (const line of body.split(/\r?\n/)) {
    if (/^\s*$/.test(line)) {
      endStanza();
    } else if (line.startsWith(' ') || line.startsWith('\t')) {
      if (!inStanza) throw malformed();
    } else {
      const match = PACKAGES_FIELD.exec(line);
      if (!match) throw malformed();
      inStanza = true;
      if (match[1] === 'Package') packageNames.push(match[2]!.trim());
      else if (match[1] === 'Version') packageVersions.push(match[2]!.trim());
      else if (match[1] === 'Path') hasPath = true;
    }
  }
  endStanza();
  return versions;
}

const packagesFiles = new SharedLoads<PackagesFile>();

/**
 * GET `path` on `upstream` through fetchUpstream, parsed with parsePackagesFile and memoized per
 * cache and URL until the response's fetchedAt + upstream.ttlSeconds. Concurrent callers on a cold
 * or expired entry share one load (SharedLoads). A file with no packages is upstream_error unless
 * `allowEmpty`.
 */
export async function getPackagesFile(
  deps: Deps,
  upstream: Upstream,
  path: string,
  options: { allowEmpty?: boolean } = {},
): Promise<PackagesFile> {
  const url = new URL(path, upstream.baseUrl).href;
  const file = await packagesFiles.get(deps, upstream, url, 'the PACKAGES file', () =>
    loadPackagesFile(deps, upstream, path, url),
  );
  // Per call, outside the shared load: callers of one URL may differ in allowEmpty.
  // An empty list would make every lookup a miss.
  if (file.versions.size === 0 && !options.allowEmpty) {
    throw new CapabilityError(
      'upstream_error',
      `${upstream.name} returned a PACKAGES file with no packages (${url})`,
      { upstream: upstream.id, url },
    );
  }
  return file;
}

async function loadPackagesFile(deps: Deps, upstream: Upstream, path: string, url: string): Promise<PackagesFile> {
  let response: Awaited<ReturnType<typeof fetchUpstream>>;
  try {
    response = await fetchUpstream(deps, upstream, path);
  } catch (error) {
    if (error instanceof CapabilityError && error.code === 'not_found') {
      throw new CapabilityError('upstream_error', `${upstream.name} has no PACKAGES file at ${url}`, {
        upstream: upstream.id,
        url,
      });
    }
    throw error;
  }
  const versions = parsePackagesFile(response.body, upstream, url);
  const { body: _body, ...meta } = response;
  return { response: meta, versions };
}
