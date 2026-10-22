import * as z from 'zod';
import { CapabilityError } from '../errors';
import type { Deps } from '../core/deps';
import { jobUrl } from '../core/pkg/job';
import type { UpstreamCache } from './cache';
import {
  DEFAULT_TIMEOUT_MS,
  fetchUpstreamJson,
  pathSegment,
  type Upstream,
  type UpstreamResponse,
} from './http';

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
    'bioc-registry: the propagation index (which package versions passed the gate or were seeded), ' +
    'build observations, and captured per-job R CMD check output and build manifests, for the bioc ' +
    '(devel) and bioc-release universes.',
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

// Covers the cache read and the parse around the fetch, which fetchUpstream's timeout does not.
const LOAD_ALLOWANCE_MS = 5_000;
const LOAD_DEADLINE_MS = (registryUpstream.timeoutMs ?? DEFAULT_TIMEOUT_MS) + LOAD_ALLOWANCE_MS;

interface MemoEntry {
  load: Promise<PropagationIndex>;
  expiresAt: number; // startedAt + LOAD_DEADLINE_MS while the load is in flight; fetchedAt + TTL once it settles
  loadDeadline: number | undefined; // set while the load is in flight
}

// The parsed index lives exactly as long as the cache in front of it: a fresh cache (each test
// app) gets a fresh memo, and the Worker (one cache per isolate) parses at most once per TTL.
// The memo holds the load Promise, so concurrent callers on a cold or expired entry share one
// cache read, fetch and parse instead of each holding their own copy of the 8 MB body.
// Request A's I/O can be cancelled by the runtime (its client disconnected) or stall outside
// fetchUpstream's timeout, so no caller waits on a load without a deadline of its own, and an
// in-flight entry past its deadline is replaced by the next caller.
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

  const now = deps.now().getTime();
  const memo = byUrl.get(url);
  if (memo && now < memo.expiresAt) {
    const shared =
      memo.loadDeadline === undefined ? await memo.load : await withinMs(memo.load, memo.loadDeadline - now, url);
    return { ...shared, response: { ...shared.response, fromCache: true } };
  }

  const loadDeadline = now + LOAD_DEADLINE_MS;
  const entry: MemoEntry = {
    load: loadPropagationIndex(deps, universe, path, url),
    expiresAt: loadDeadline,
    loadDeadline,
  };
  byUrl.set(url, entry);
  try {
    const index = await withinMs(entry.load, LOAD_DEADLINE_MS, url);
    entry.expiresAt = Date.parse(index.response.fetchedAt) + registryUpstream.ttlSeconds * 1000;
    entry.loadDeadline = undefined;
    return index;
  } catch (error) {
    if (byUrl.get(url) === entry) byUrl.delete(url); // errors are not cached
    throw error;
  }
}

/** Rejects with upstream_timeout if `promise` has not settled within `ms`. */
async function withinMs<T>(promise: Promise<T>, ms: number, url: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new CapabilityError(
            'upstream_timeout',
            `${registryUpstream.name} did not deliver the propagation index in time (${url}). Retry shortly.`,
            { upstream: registryUpstream.id, url },
          ),
        ),
      Math.max(ms, 0),
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
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

export interface CheckFiles {
  response: UpstreamResponse; // for sourceFor()
  files: Record<string, string>; // basename → file text, exactly as JSON.parse returned it
}

/** GET checks/{universe}/{job}. 404 → not_found explaining capture. */
export async function getCheckFiles(deps: Deps, universe: Universe, job: string): Promise<CheckFiles> {
  const path = `checks/${pathSegment(universe)}/${pathSegment(job)}`;
  let fetched: Awaited<ReturnType<typeof fetchUpstreamJson>>;
  try {
    fetched = await fetchUpstreamJson(deps, registryUpstream, path);
  } catch (error) {
    if (error instanceof CapabilityError && error.code === 'not_found') {
      throw new CapabilityError(
        'not_found',
        `The registry has no captured check output for ${universe} job ${job}. It captures each job's check ` +
          'artifact once, walking forward from when capture was switched on, and r-universe deletes artifacts ' +
          'after about 100 days, so a job that capture missed stays unavailable. Check that the universe is the ' +
          `one the job id came from in pkg_status. The job's GitHub Actions page is ${jobUrl(universe, job)}.`,
        error.details,
      );
    }
    throw error;
  }
  const { response, json } = fetched;
  // No zod here: a "__proto__" key must stay an own data property.
  if (
    typeof json !== 'object' ||
    json === null ||
    Array.isArray(json) ||
    !Object.values(json).every((value) => typeof value === 'string')
  ) {
    throw new CapabilityError(
      'upstream_error',
      `${registryUpstream.name} returned check output for job ${job} that is not an object of file texts`,
      { upstream: registryUpstream.id, url: response.url },
    );
  }
  return { response, files: json as Record<string, string> };
}

export const BuildManifestSchema = z.object({
  image: z.string().nullish(),
  repos: z.array(z.string()).nullish(),
  deps: z.record(z.string(), z.string()).nullish(), // package → resolved version
});
export type BuildManifest = z.infer<typeof BuildManifestSchema>;

/** GET builds/{universe}/{job}. 404 → not_found explaining capture. */
export async function getBuildManifest(
  deps: Deps,
  universe: Universe,
  job: string,
): Promise<{ response: UpstreamResponse; manifest: BuildManifest }> {
  const path = `builds/${pathSegment(universe)}/${pathSegment(job)}`;
  let fetched: Awaited<ReturnType<typeof fetchUpstreamJson>>;
  try {
    fetched = await fetchUpstreamJson(deps, registryUpstream, path);
  } catch (error) {
    if (error instanceof CapabilityError && error.code === 'not_found') {
      throw new CapabilityError(
        'not_found',
        `The registry has no build manifest for ${universe} job ${job}. Manifests are parsed from the job log, ` +
          'which the registry captures once, walking forward from when capture was switched on; a job that ' +
          'capture missed never gets one. Check that the universe is the one the job id came from in ' +
          `pkg_status. The job's GitHub Actions page is ${jobUrl(universe, job)}.`,
        error.details,
      );
    }
    throw error;
  }
  const { response, json } = fetched;
  const parsed = BuildManifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new CapabilityError(
      'upstream_error',
      `${registryUpstream.name} returned a build manifest for job ${job} with an unexpected shape`,
      { upstream: registryUpstream.id, url: response.url },
    );
  }
  return { response, manifest: parsed.data };
}
