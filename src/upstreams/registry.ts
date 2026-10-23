import * as z from 'zod';
import { CapabilityError } from '../errors';
import type { Deps } from '../core/deps';
import {
  fetchUpstreamJson,
  pathSegment,
  type Upstream,
  type UpstreamResponse,
  type UpstreamResponseMeta,
} from './http';
import { SharedLoads } from './shared-load';

export const UNIVERSES = ['bioc', 'bioc-release'] as const;
export type Universe = (typeof UNIVERSES)[number];

/** The job's GitHub page. GitHub resolves /runs/{job} without the run id. Built, never fetched. */
export function jobUrl(universe: Universe, job: string): string {
  return `https://github.com/r-universe/${universe}/runs/${job}`;
}

export const REGISTRY_BASE_URL = 'https://bioc-registry.seandavi.workers.dev/';

export const registryUpstream: Upstream = {
  id: 'registry',
  name: 'Bioconductor propagation registry',
  baseUrl: REGISTRY_BASE_URL,
  ttlSeconds: 300,
  timeoutMs: 15_000, // the index is ~8 MB
  maxBytes: 16 * 1024 * 1024, // the devel index was 8.0 MB on 2026-10-22; /checks responses reach several MB
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
  response: UpstreamResponseMeta; // for sourceFor(); the ~8 MB body is dropped once parsed
  packages: Record<string, unknown>; // parsed index.json; entries unvalidated
}

const propagationIndexes = new SharedLoads<PropagationIndex>();

/** GET data/prop/{universe}/index.json, parsed once per cache TTL per isolate. */
export async function getPropagationIndex(deps: Deps, universe: Universe): Promise<PropagationIndex> {
  const path = `data/prop/${pathSegment(universe)}/index.json`;
  const url = new URL(path, REGISTRY_BASE_URL).href;
  return propagationIndexes.get(deps, registryUpstream, url, 'the propagation index', () =>
    loadPropagationIndex(deps, universe, path, url),
  );
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
  const { body: _body, ...meta } = response;
  return { response: meta, packages: json as Record<string, unknown> };
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
        `The registry has no captured check output for ${universe} job ${job}. It captures check artifacts ` +
          'walking forward in job order and r-universe deletes them after about 100 days, so this job may not ' +
          'be captured yet or may never be. Jobs whose check is FAIL or FAILURE produce no check output. Check ' +
          'that the universe is the one the job id came from in pkg_status. ' +
          `The job's GitHub Actions page is ${jobUrl(universe, job)}.`,
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
          'which the registry captures walking forward in job order, so this job may not be captured yet or may ' +
          'never be. Check that the universe is the one the job id came from in pkg_status. ' +
          `The job's GitHub Actions page is ${jobUrl(universe, job)}.`,
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
