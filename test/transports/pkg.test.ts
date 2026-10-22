import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, test } from 'vitest';
import { AboutSchema } from '../../src/core/about';
import { pkgModule } from '../../src/core/pkg';
import { modules, validateRegistry } from '../../src/core/registry';
import { connectClient, makeTestApp } from '../support/app';
import { BIOC_INDEX_URL, pkgRoutes, RELEASE_INDEX_URL, ruUrl } from '../support/pkg-routes';

let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

function testApp() {
  return makeTestApp({ routes: pkgRoutes, extraModules: [pkgModule] });
}

async function get(path: string) {
  const { app, fetch } = testApp();
  const response = await app.fetch(new Request('http://test.local' + path));
  return { response, body: (await response.json()) as Record<string, any>, fetch };
}

const textOf = (result: { content?: unknown }) => (result.content as { text: string }[])[0]!.text;

test('the production registry, including pkg, validates', () => {
  expect(() => validateRegistry(modules)).not.toThrow();
  expect(modules.map((m) => m.name)).toContain('pkg');
});

describe('MCP', () => {
  test('/mcp/pkg lists exactly pkg_status; /mcp also lists meta_ping', async () => {
    client = await connectClient(testApp().app, '/mcp/pkg');
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['pkg_status']);
    await client.close();
    client = await connectClient(testApp().app, '/mcp');
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('meta_ping');
    expect(names).toContain('pkg_status');
  });

  test('an unknown package is an isError result starting not_found:', async () => {
    const { app, fetch } = testApp();
    client = await connectClient(app, '/mcp/pkg');
    const result = await client.callTool({ name: 'pkg_status', arguments: { package: 'edgr' } });
    expect(result.isError).toBe(true);
    expect(textOf(result).startsWith('not_found:')).toBe(true);
    expect(fetch.calls).toContain(BIOC_INDEX_URL);
    expect(fetch.calls).toContain(ruUrl('bioc', 'edgr'));
  });
});

describe('GET /api/v1/pkg/status', () => {
  test('returns the same envelope MCP returns as structuredContent', async () => {
    const { response, body } = await get('/api/v1/pkg/status?package=trackViewer');
    expect(response.status).toBe(200);
    expect(body.data.package).toBe('trackViewer');
    expect(body.sources).toHaveLength(2);
    client = await connectClient(testApp().app, '/mcp/pkg');
    const result = await client.callTool({ name: 'pkg_status', arguments: { package: 'trackViewer' } });
    expect(result.isError).toBeFalsy();
    expect(body).toEqual(result.structuredContent);
  });

  test('an unknown package is 404 not_found with suggestions', async () => {
    const { response, body } = await get('/api/v1/pkg/status?package=edgr');
    expect(response.status).toBe(404);
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toContain('Did you mean: edge, edgeR?');
  });

  test.each(["a'b", '1abc', 'x', 'edgeR.'])('invalid name %j is 400 invalid_input with no fetch', async (name) => {
    const { response, body, fetch } = await get(`/api/v1/pkg/status?package=${encodeURIComponent(name)}`);
    expect(response.status).toBe(400);
    expect(body.error.code).toBe('invalid_input');
    expect(fetch.calls).toEqual([]);
  });

  test('universe=cran is 400', async () => {
    const { response, body } = await get('/api/v1/pkg/status?package=edgeR&universe=cran');
    expect(response.status).toBe(400);
    expect(body.error.code).toBe('invalid_input');
  });

  test('universe=bioc-release fetches only the bioc-release URLs', async () => {
    const { response, fetch } = await get('/api/v1/pkg/status?package=edgeR&universe=bioc-release');
    expect(response.status).toBe(200);
    expect([...fetch.calls].sort()).toEqual([RELEASE_INDEX_URL, ruUrl('bioc-release', 'edgeR')].sort());
  });
});

describe('GET /api/v1/about', () => {
  test('lists the registry and both r-universe upstreams as used by pkg', async () => {
    const { response, body } = await get('/api/v1/about');
    expect(response.status).toBe(200);
    const about = AboutSchema.parse(body);
    for (const id of ['registry', 'r-universe-bioc', 'r-universe-bioc-release']) {
      expect(about.upstreams.find((u) => u.id === id)?.used_by).toEqual(['pkg']);
    }
    expect(about.modules.find((m) => m.name === 'pkg')?.tools).toEqual(['pkg_status']);
  });
});
