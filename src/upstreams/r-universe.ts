import * as z from 'zod';
import type { Source } from '../envelope';
import { CapabilityError } from '../errors';
import type { Deps } from '../core/deps';
import { fetchUpstreamJson, pathSegment, type Upstream, type UpstreamResponse } from './http';
import type { Universe } from './registry';

export const rUniverseUpstreams: Record<Universe, Upstream> = {
  bioc: {
    id: 'r-universe-bioc',
    name: 'r-universe (bioc)',
    baseUrl: 'https://bioc.r-universe.dev/api/',
    ttlSeconds: 300,
    description: 'r-universe builds and checks of Bioconductor devel (bioc.r-universe.dev).',
  },
  'bioc-release': {
    id: 'r-universe-bioc-release',
    name: 'r-universe (bioc-release)',
    baseUrl: 'https://bioc-release.r-universe.dev/api/',
    ttlSeconds: 300,
    description: 'r-universe builds and checks of Bioconductor release (bioc-release.r-universe.dev).',
  },
};

const RUniverseCommitSchema = z.object({ id: z.string(), time: z.number(), message: z.string().optional() });
const RUniverseJobSchema = z.object({
  job: z.number().int(),
  config: z.string(),
  r: z.string().nullish(),
  check: z.string().nullish(),
});

export const RUniversePackageSchema = z.object({
  Package: z.string(),
  Version: z.string(),
  _status: z.string(),
  _commit: RUniverseCommitSchema,
  _created: z.string().nullish(),
  _buildurl: z.string(),
  _bioccheck: z.object({ error: z.number(), warning: z.number(), note: z.number() }).nullish(),
  _jobs: z.array(RUniverseJobSchema).nullish(),
  _failure: z
    .object({
      version: z.string(),
      commit: RUniverseCommitSchema,
      buildurl: z.string(),
      date: z.string(),
      job: RUniverseJobSchema.nullish(),
    })
    .nullish(),
});
export type RUniversePackage = z.infer<typeof RUniversePackageSchema>;

export type UniversePackageResult =
  | { found: true; response: UpstreamResponse; record: RUniversePackage }
  | { found: false; source: Source }; // what was asked, as_of = deps.now()

/** GET {universe}.r-universe.dev/api/packages/{name}. A 404 is { found: false }, not an error. */
export async function getUniversePackage(deps: Deps, universe: Universe, name: string): Promise<UniversePackageResult> {
  const upstream = rUniverseUpstreams[universe];
  let fetched: Awaited<ReturnType<typeof fetchUpstreamJson>>;
  try {
    fetched = await fetchUpstreamJson(deps, upstream, `packages/${pathSegment(name)}`);
  } catch (error) {
    if (error instanceof CapabilityError && error.code === 'not_found' && error.details.url !== undefined) {
      return { found: false, source: { url: error.details.url, as_of: deps.now().toISOString() } };
    }
    throw error;
  }
  const { response, json } = fetched;
  const parsed = RUniversePackageSchema.safeParse(json);
  if (!parsed.success || parsed.data.Package !== name) {
    throw new CapabilityError('upstream_error', `${upstream.name} returned an unexpected record for ${name}`, {
      upstream: upstream.id,
      url: response.url,
    });
  }
  return { found: true, response, record: parsed.data };
}
