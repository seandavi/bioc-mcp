import * as z from 'zod';
import { CapabilityError } from '../errors';
import type { Deps } from '../core/deps';
import type { UpstreamCache } from './cache';
import { fetchUpstreamJson, pathSegment, type Upstream, type UpstreamResponse } from './http';

export const UNIVERSES = ['bioc', 'bioc-release'] as const;
export type Universe = (typeof UNIVERSES)[number];

export const REGISTRY_BASE_URL = 'https://bioc-registry.seandavi.workers.dev/';

export const registryUpstream: Upstream = {
  id: 'registry',
  name: 'Bioconductor propagation registry',
  baseUrl: REGISTRY_BASE_URL,
  ttlSeconds: 300,
  timeoutMs: 15_000, // the index is ~8 MB
  description:
    'bioc-registry: the propagation index (which package versions passed the gate or were seeded) ' +
    'and build observations, for the bioc (devel) and bioc-release universes.',
};

const ArtifactSchema = z.object({
  os: z.string(),
  r: z.string(), // '' for os 'src'
  arch: z.string().optional(),
  distro: z.string().optional(),
});

export const RegistryEntrySchema = z.object({
  version: z.string(),
  sha256: z.string(),
  ts: z.string(),
  bioccheck: z.string().nullish(), // absent on 895/2,894; null on seeded entries
  artifacts: z.array(ArtifactSchema),
  archs: z.array(z.string()).optional(), // absent on 1,837/2,894 (older entries)
  origin: z.string().optional(), // absent → 'r-universe' (registry docs: "read as r-universe")
  meta: z
    .object({
      commit: z.object({ id: z.string(), time: z.number() }).optional(), // time: epoch seconds
      git_url: z.string().optional(),
    })
    .optional(),
});
export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;

export interface PropagationIndex {
  response: UpstreamResponse; // for sourceFor()
  packages: Record<string, unknown>; // parsed index.json; entries unvalidated
}

interface MemoEntry {
  load: Promise<PropagationIndex>;
  expiresAt: number; // Infinity while the load is in flight; fetchedAt + TTL once it settles
}

// The parsed index lives exactly as long as the cache in front of it: a fresh cache (each test
// app) gets a fresh memo, and the Worker (one cache per isolate) parses at most once per TTL.
// The memo holds the load Promise, so concurrent callers on a cold or expired entry share one
// cache read, fetch and parse instead of each holding their own copy of the 8 MB body.
const parsedIndexes = new WeakMap<UpstreamCache, Map<string, MemoEntry>>();

/** GET data/prop/{universe}/index.json, parsed once per cache TTL per isolate. */
export async function getPropagationIndex(deps: Deps, universe: Universe): Promise<PropagationIndex> {
  const path = `data/prop/${pathSegment(universe)}/index.json`;
  const url = new URL(path, REGISTRY_BASE_URL).href;

  let byUrl = parsedIndexes.get(deps.cache);
  if (!byUrl) {
    byUrl = new Map();
    parsedIndexes.set(deps.cache, byUrl);
  }

  const memo = byUrl.get(url);
  if (memo && deps.now().getTime() < memo.expiresAt) {
    const shared = await memo.load;
    return { ...shared, response: { ...shared.response, fromCache: true } };
  }

  const entry: MemoEntry = { load: loadPropagationIndex(deps, universe, path, url), expiresAt: Infinity };
  byUrl.set(url, entry);
  try {
    const index = await entry.load;
    entry.expiresAt = Date.parse(index.response.fetchedAt) + registryUpstream.ttlSeconds * 1000;
    return index;
  } catch (error) {
    if (byUrl.get(url) === entry) byUrl.delete(url); // errors are not cached
    throw error;
  }
}

async function loadPropagationIndex(
  deps: Deps,
  universe: Universe,
  path: string,
  url: string,
): Promise<PropagationIndex> {
  const details = { upstream: registryUpstream.id, url };
  let fetched: Awaited<ReturnType<typeof fetchUpstreamJson>>;
  try {
    fetched = await fetchUpstreamJson(deps, registryUpstream, path);
  } catch (error) {
    if (error instanceof CapabilityError && error.code === 'not_found') {
      throw new CapabilityError(
        'upstream_error',
        `${registryUpstream.name} has no propagation index for ${universe}`,
        details,
      );
    }
    throw error;
  }
  const { response, json } = fetched;
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new CapabilityError(
      'upstream_error',
      `${registryUpstream.name} returned an index that is not a JSON object`,
      details,
    );
  }
  return { response, packages: json as Record<string, unknown> };
}

/** packages[name] validated with RegistryEntrySchema; undefined when absent. */
export function registryEntry(index: PropagationIndex, name: string): RegistryEntry | undefined {
  if (!Object.hasOwn(index.packages, name)) return undefined;
  const parsed = RegistryEntrySchema.safeParse(index.packages[name]);
  if (!parsed.success) {
    throw new CapabilityError(
      'upstream_error',
      `${registryUpstream.name} entry for ${name} has an unexpected shape`,
      { upstream: registryUpstream.id, url: index.response.url },
    );
  }
  return parsed.data;
}
