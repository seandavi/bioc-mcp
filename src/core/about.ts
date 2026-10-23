import * as z from 'zod';
import { SourceSchema } from '../envelope';
import type { Module } from './registry';
import { PROTOCOL_VERSION, VERSION } from '../version';

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
      built_at: z.string(),
      build_commit: z.string().nullable(),
      inputs: z.array(SourceSchema),
    }),
  ),
});
export type About = z.infer<typeof AboutSchema>;

/** Describes every registered module, whichever toolset path served it. */
export function buildAbout(modules: readonly Module[]): About {
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
      (module.datasets?.() ?? []).map((dataset) => ({
        id: dataset.id,
        module: module.name,
        description: dataset.description,
        built_at: dataset.built_at,
        build_commit: dataset.build_commit,
        inputs: dataset.inputs,
      })),
    ),
  };
}
