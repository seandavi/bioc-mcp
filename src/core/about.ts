import * as z from 'zod';
import { SourceSchema } from '../envelope';
import type { Module } from './registry';
import { PROTOCOL_VERSION, VERSION } from '../version';

export const DatasetCommitSchema = z.object({
  repo: z.string().describe("GitHub repository, e.g. 'seandavi/bioc-infrastructure'"),
  ref: z.string().describe('Branch the input follows'),
  sha: z.string().describe('Commit the input was built from (40 hex); its page is https://github.com/<repo>/commit/<sha>'),
  head_sha: z.string().describe('Head of ref when the dataset was built; differs from sha when the input lagged its branch'),
  head_committed_at: z.string().describe('Committer date of head_sha (ISO 8601)'),
});

export const DatasetInputSchema = SourceSchema.extend({
  commit: DatasetCommitSchema.nullable().describe('Source commit of this input; null when unknown'),
  possibly_stale: z.string().nullable().describe('Why this input may be out of date; null when there is no known reason'),
});
export type DatasetInput = z.infer<typeof DatasetInputSchema>;

export const AboutSchema = z.object({
  name: z.literal('bioc-mcp'),
  version: z.string(),
  protocol_version: z.literal('2026-07-28'),
  description: z.string(),
  endpoints: z.object({
    mcp: z.literal('/mcp'),
    rest: z.literal('/api/v1'),
    openapi: z.literal('/api/openapi.json'),
  }),
  modules: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      mcp_path: z.string(), // `/mcp/${name}`
      tools: z.array(z.string()), // capability names, registry order
    }),
  ),
  upstreams: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      base_url: z.string(),
      ttl_seconds: z.number().int(),
      description: z.string(),
      used_by: z.array(z.string()), // module names
    }),
  ),
  datasets: z.array(
    z.object({
      id: z.string(),
      module: z.string(), // the module that declared it
      description: z.string(),
      built_at: z.string().describe('When the dataset was built (ISO 8601)'),
      build_commit: z.string().nullable().describe("This server's commit the dataset was built from (CI's GITHUB_SHA); null when built locally"),
      age_days: z.number().int().nonnegative().describe('Whole days since built_at'),
      possibly_stale: z.array(z.string()).describe('Every reason the dataset or one of its inputs may be out of date; [] when none'),
      inputs: z.array(DatasetInputSchema),
    }),
  ),
});
export type About = z.infer<typeof AboutSchema>;

/** Describes every registered module, whichever toolset path served it. */
export function buildAbout(modules: readonly Module[], now: Date): About {
  const upstreams = new Map<string, About['upstreams'][number]>();
  for (const module of modules) {
    for (const upstream of module.upstreams) {
      const entry = upstreams.get(upstream.id);
      if (entry) {
        if (!entry.used_by.includes(module.name)) entry.used_by.push(module.name);
      } else {
        upstreams.set(upstream.id, {
          id: upstream.id,
          name: upstream.name,
          base_url: upstream.baseUrl,
          ttl_seconds: upstream.ttlSeconds,
          description: upstream.description,
          used_by: [module.name],
        });
      }
    }
  }
  return {
    name: 'bioc-mcp',
    version: VERSION,
    protocol_version: PROTOCOL_VERSION,
    description:
      'Read-only MCP server and REST API over public Bioconductor infrastructure data. ' +
      'Every result lists its sources with an as-of time.',
    endpoints: { mcp: '/mcp', rest: '/api/v1', openapi: '/api/openapi.json' },
    modules: modules.map((module) => ({
      name: module.name,
      description: module.description,
      mcp_path: `/mcp/${module.name}`,
      tools: module.capabilities.map((capability) => capability.name),
    })),
    upstreams: [...upstreams.values()],
    datasets: modules.flatMap((module) =>
      (module.datasets?.(now) ?? []).map((dataset) => ({
        id: dataset.id,
        module: module.name,
        description: dataset.description,
        built_at: dataset.built_at,
        build_commit: dataset.build_commit,
        age_days: dataset.age_days,
        possibly_stale: dataset.possibly_stale,
        inputs: dataset.inputs,
      })),
    ),
  };
}
