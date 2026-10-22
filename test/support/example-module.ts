import * as z from 'zod';
import { defineCapability, type Module } from '../../src/core/registry';
import { fetchUpstreamJson, pathSegment, sourceFor, type Upstream } from '../../src/upstreams/http';

export const exampleUpstream: Upstream = {
  id: 'example',
  name: 'Example upstream',
  baseUrl: 'https://upstream.test/',
  ttlSeconds: 300,
  timeoutMs: 50,
  description: 'Synthetic upstream used only in tests.',
};

export const exampleItem = defineCapability({
  module: 'example',
  name: 'example_item',
  title: 'Example item',
  description: 'Test-only capability backed by the example upstream.',
  input: z.object({
    id: z.string().regex(/^[a-z0-9-]+$/).describe('Item id'),
    repeat: z.number().int().min(1).max(10_000).default(1).describe('Repeat the title this many times'),
  }),
  data: z.object({ id: z.string(), title: z.string(), body: z.string() }),
  async handler({ id, repeat }, deps) {
    const { response, json } = await fetchUpstreamJson(
      deps,
      exampleUpstream,
      `items/${pathSegment(id)}.json`,
    );
    const item = z.object({ id: z.string(), title: z.string(), updated: z.string() }).parse(json);
    return {
      data: { id: item.id, title: item.title, body: item.title.repeat(repeat) },
      summary: `Item ${item.id}: ${item.title}.`,
      sources: [sourceFor(response, item.updated)],
    };
  },
});

export const exampleModule: Module = {
  name: 'example',
  description: 'Test-only module.',
  upstreams: [exampleUpstream],
  capabilities: [exampleItem],
};
