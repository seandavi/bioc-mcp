import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, test } from 'vitest';
import { AboutSchema } from '../../src/core/about';
import { metaModule } from '../../src/core/meta';
import { opsModule } from '../../src/core/ops';
import { pkgModule } from '../../src/core/pkg';
import { modules, validateRegistry } from '../../src/core/registry';
import { connectClient, makeTestApp } from '../support/app';
import { docsTestModule } from '../support/docs';
import { GITHUB_RECORDED_AT, githubRoutes, githubUrl } from '../support/github-routes';
import type { FixtureRoute } from '../support/fixture-fetch';

const KINDS = ['summary', 'issues', 'prs', 'workflows', 'failures'] as const;
const now = () => GITHUB_RECORDED_AT;

// pkg's triage prompt names the docs tools, so a registry holding pkg must hold docs too.
const docsModule = await docsTestModule();

let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

function testApp(routes: Record<string, FixtureRoute> = githubRoutes()) {
  return makeTestApp({ routes, extraModules: [opsModule], now });
}

async function get(path: string, routes?: Record<string, FixtureRoute>) {
  const { app, fetch } = testApp(routes);
  const response = await app.fetch(new Request('http://test.local' + path));
  return { response, body: (await response.json()) as Record<string, any>, fetch };
}

const textOf = (result: { content?: unknown }) => (result.content as { text: string }[])[0]!.text;

test('the production registry, including ops, validates', () => {
  expect(() => validateRegistry(modules)).not.toThrow();
  expect(modules.map((m) => m.name)).toEqual(['meta', 'pkg', 'ops', 'docs']);
});

describe('MCP', () => {
  test('/mcp/ops lists exactly ops_activity; /mcp also lists the other tools', async () => {
    client = await connectClient(testApp().app, '/mcp/ops');
    const tool = (await client.listTools()).tools;
    expect(tool.map((t) => t.name)).toEqual(['ops_activity']);
    expect(tool[0]!.outputSchema).toBeDefined();
    await client.close();
    const all = makeTestApp({ routes: githubRoutes(), extraModules: [pkgModule, opsModule, docsModule], now });
    client = await connectClient(all.app, '/mcp');
    const names = (await client.listTools()).tools.map((t) => t.name);
    const expected = [metaModule, pkgModule, opsModule, docsModule].flatMap((m) => m.capabilities.map((c) => c.name));
    expect(names.filter((name) => !name.startsWith('example_')).sort()).toEqual([...expected].sort());
  });

  test('the tool text says what workflows lists and never mentions bioc-health', async () => {
    client = await connectClient(testApp().app, '/mcp/ops');
    const [tool] = (await client.listTools()).tools;
    expect(JSON.stringify(tool)).not.toContain('bioc-health');
    expect(tool!.description).toContain(
      'every workflow when repo is given; without repo, only those that fail or warn',
    );
  });

  test('a refused GitHub is an isError result starting upstream_error:', async () => {
    const routes = Object.fromEntries(Object.keys(githubRoutes()).map((url) => [url, { status: 403 } as FixtureRoute]));
    client = await connectClient(testApp(routes).app, '/mcp/ops');
    const result = await client.callTool({ name: 'ops_activity', arguments: { kind: 'summary' } });
    expect(result.isError).toBe(true);
    expect(textOf(result).startsWith('upstream_error:')).toBe(true);
    expect(textOf(result)).toContain('rate limit');
  });
});

describe('GET /api/v1/ops/activity', () => {
  test.each(KINDS)('kind=%s returns the envelope MCP returns as structuredContent', async (kind) => {
    const { response, body } = await get(`/api/v1/ops/activity?kind=${kind}`);
    expect(response.status).toBe(200);
    expect(body.data.kind).toBe(kind);
    client = await connectClient(testApp().app, '/mcp/ops');
    const result = await client.callTool({ name: 'ops_activity', arguments: { kind } });
    expect(result.isError).toBeFalsy();
    expect(body).toEqual(result.structuredContent);
    expect(textOf(result)).toBe(body.summary);
  });

  test('no kind means summary', async () => {
    const { response, body } = await get('/api/v1/ops/activity');
    expect(response.status).toBe(200);
    expect(body.data.kind).toBe('summary');
  });

  test('repo narrows to one repo', async () => {
    const { body } = await get('/api/v1/ops/activity?kind=workflows&repo=bioc-website');
    expect(body.data.listed).toBe('all');
    expect(body.data.workflows).toHaveLength(3);
    expect(body.sources).toEqual([{ url: githubUrl('bioc-website'), as_of: GITHUB_RECORDED_AT.toISOString() }]);
  });

  test.each(['repo=bioc-nope', 'kind=all', 'kind=failures&repo=bioc-registry'])('?%s is 400 invalid_input with no GitHub request', async (query) => {
    const { response, body, fetch } = await get(`/api/v1/ops/activity?${query}`);
    expect(response.status).toBe(400);
    expect(body.error.code).toBe('invalid_input');
    expect(fetch.calls).toEqual([]);
  });

  test('every repo refused is 502 upstream_error mentioning the rate limit', async () => {
    const routes = Object.fromEntries(Object.keys(githubRoutes()).map((url) => [url, { status: 429 } as FixtureRoute]));
    const { response, body } = await get('/api/v1/ops/activity?kind=issues', routes);
    expect(response.status).toBe(502);
    expect(body.error.code).toBe('upstream_error');
    expect(body.error.message).toContain('rate limit');
    expect(body.error.message).toContain('GITHUB_TOKEN');
  });

  test('is described in the OpenAPI document', async () => {
    const { body } = await get('/api/openapi.json');
    expect(body.paths['/api/v1/ops/activity'].get.parameters.map((p: any) => p.name).sort()).toEqual(['kind', 'repo']);
  });
});

describe('GET /api/v1/about', () => {
  test('lists the github upstream as used by ops', async () => {
    const { body } = await get('/api/v1/about');
    const about = AboutSchema.parse(body);
    expect(about.upstreams.find((u) => u.id === 'github')).toMatchObject({ used_by: ['ops'], ttl_seconds: 120 });
    expect(about.modules.find((m) => m.name === 'ops')?.tools).toEqual(['ops_activity']);
  });
});
