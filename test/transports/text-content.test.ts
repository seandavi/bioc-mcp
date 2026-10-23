import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, test } from 'vitest';
import { modules } from '../../src/core/registry';
import { envelopeBytes, MAX_RESULT_BYTES, type Envelope } from '../../src/envelope';
import { connectClient, makeTestApp } from '../support/app';
import { depsRoutes } from '../support/deps-routes';
import { docsTestModule } from '../support/docs';
import { bioconductorRoutes } from '../support/bioconductor-routes';
import { GITHUB_RECORDED_AT, githubRoutes } from '../support/github-routes';
import { pkgRoutes } from '../support/pkg-routes';

const CALLS: readonly [tool: string, args: Record<string, unknown>][] = [
  ['meta_ping', {}],
  ['pkg_status', { package: 'trackViewer' }],
  ['pkg_status', { package: 'edgeR', universe: 'bioc-release' }],
  ['pkg_check_output', { universe: 'bioc', job: '96299707840' }],
  ['pkg_check_output', { universe: 'bioc', job: '96299707840', full: true }],
  ['pkg_build_environment', { universe: 'bioc', job: '96299707840', dependencies: ['biomaRt', 'httr2'] }],
  ['pkg_release_info', {}],
  ['pkg_downloads', { package: 'edgeR' }],
  ['pkg_repo_diff', {}],
  ['pkg_revdeps', { package: 'flowWorkspace' }],
  ['pkg_missing_deps', {}],
  ['ops_activity', { kind: 'summary' }],
  ['ops_activity', { kind: 'issues' }],
  ['ops_activity', { kind: 'prs' }],
  ['ops_activity', { kind: 'workflows' }],
  ['ops_activity', { kind: 'failures' }],
  ['docs_search', { query: 'propagation gate' }],
  ['docs_read', { id_or_url: 'site:propagation-gate.html' }],
];

let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

// depsRoutes replaces the devel index with the trimmed one these two tools' scenarios use.
const DEPS_TOOLS = new Set(['pkg_revdeps', 'pkg_missing_deps']);

async function call(tool: string, args: Record<string, unknown>) {
  const { app } = makeTestApp({
    routes: {
      ...pkgRoutes,
      ...bioconductorRoutes,
      ...githubRoutes(),
      ...(DEPS_TOOLS.has(tool) ? depsRoutes : {}),
    },
    // Mount every production module so adding one needs only CALLS rows and fixture routes (#36);
    // docs swaps in the fixture-built index.
    extraModules: await Promise.all(
      modules.filter((m) => m.name !== 'meta').map((m) => (m.name === 'docs' ? docsTestModule() : m)),
    ),
    now: () => GITHUB_RECORDED_AT,
  });
  client = await connectClient(app, `/mcp/${modules.map((m) => m.name).join('+')}`);
  const result = await client.callTool({ name: tool, arguments: args });
  return {
    isError: result.isError,
    content: result.content as { type: string; text: string }[],
    structured: result.structuredContent as unknown as Envelope<any>,
  };
}

test('covers every production tool', () => {
  expect(new Set(CALLS.map(([tool]) => tool))).toEqual(
    new Set(modules.flatMap((module) => module.capabilities.map((capability) => capability.name))),
  );
});

describe('MCP text content', () => {
  test.each(CALLS)('%s %j: text content carries data and sources within the size limit', async (tool, args) => {
    const { isError, content, structured } = await call(tool, args);
    expect(isError).toBeFalsy();
    expect(content).toHaveLength(2);
    expect(content.map((block) => block.type)).toEqual(['text', 'text']);
    expect(content[0]!.text).toBe(structured.summary);
    expect(JSON.parse(content[1]!.text)).toEqual({ data: structured.data, sources: structured.sources });
    const textBytes = content.reduce((sum, block) => sum + new TextEncoder().encode(block.text).length, 0);
    expect(textBytes).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(textBytes).toBeLessThan(envelopeBytes(structured));
  });

  test('pkg_status text names every job id and job URL', async () => {
    const { content, structured } = await call('pkg_status', { package: 'trackViewer' });
    const jobs = structured.data.upstream.jobs as { job: string | number; url: string }[];
    expect(jobs).toHaveLength(10);
    for (const job of jobs) {
      expect(content[1]!.text).toContain(String(job.job));
      expect(content[1]!.text).toContain(job.url);
    }
  });
});
