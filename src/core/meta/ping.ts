import { VERSION } from '../../version';
import * as z from 'zod';
import { defineCapability } from '../capability';

export const metaPing = defineCapability({
  module: 'meta',
  name: 'meta_ping',
  title: 'Ping',
  description:
    'Check that the Bioconductor MCP server is reachable and report its version. ' +
    'Use only as a connectivity check; read the bioc://about resource (REST: GET /api/v1/about) ' +
    'for the modules, tools and upstream sources the server covers and each source\'s cache TTL. ' +
    'Freshness is per result: every tool result lists its sources with an as_of time.',
  input: z.object({}),
  data: z.object({ ok: z.literal(true), version: z.string() }),
  async handler() {
    return { data: { ok: true as const, version: VERSION }, summary: `bioc-mcp ${VERSION} is up.`, sources: [] };
  },
});
