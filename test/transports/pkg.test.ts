import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, test } from 'vitest';
import { AboutSchema } from '../../src/core/about';
import { pkgModule } from '../../src/core/pkg';
import { modules, validateRegistry } from '../../src/core/registry';
import { connectClient, makeTestApp } from '../support/app';
import { bioconductorRoutes, statsPageUrl, statsTabUrl } from '../support/bioconductor-routes';
import { BIOC_INDEX_URL, buildsUrl, checksUrl, pkgRoutes, RELEASE_INDEX_URL, ruUrl } from '../support/pkg-routes';

let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

function testApp() {
  return makeTestApp({ routes: { ...pkgRoutes, ...bioconductorRoutes }, extraModules: [pkgModule] });
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
  test('/mcp/pkg lists exactly the pkg tools; /mcp also lists meta_ping', async () => {
    client = await connectClient(testApp().app, '/mcp/pkg');
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
      'pkg_status',
      'pkg_check_output',
      'pkg_build_environment',
      'pkg_release_info',
      'pkg_downloads',
      'pkg_repo_diff',
    ]);
    await client.close();
    client = await connectClient(testApp().app, '/mcp');
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('meta_ping');
    expect(names).toContain('pkg_status');
    expect(names).toContain('pkg_release_info');
    expect(names).toContain('pkg_downloads');
    expect(names).toContain('pkg_repo_diff');
    expect(names).toContain('pkg_check_output');
    expect(names).toContain('pkg_build_environment');
  });

  test('pkg_check_output on a job the registry has not captured is isError not_found:', async () => {
    client = await connectClient(testApp().app, '/mcp/pkg');
    const result = await client.callTool({
      name: 'pkg_check_output',
      arguments: { universe: 'bioc', job: '112702240220' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result).startsWith('not_found:')).toBe(true);
    expect(textOf(result)).toContain('has no captured check output');
  });

  test('pkg_build_environment on the same job is isError not_found: naming the build manifest', async () => {
    client = await connectClient(testApp().app, '/mcp/pkg');
    const result = await client.callTool({
      name: 'pkg_build_environment',
      arguments: { universe: 'bioc', job: '112702240220' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result).startsWith('not_found:')).toBe(true);
    expect(textOf(result)).toContain('build manifest');
  });

  test('a job id passed as a number is rejected as invalid input', async () => {
    const { app, fetch } = testApp();
    client = await connectClient(app, '/mcp/pkg');
    for (const name of ['pkg_check_output', 'pkg_build_environment']) {
      const result = await client.callTool({ name, arguments: { universe: 'bioc', job: 96299707840 } }).catch((e) => e);
      const rejected = result instanceof Error || result.isError === true;
      expect(rejected).toBe(true);
    }
    expect(fetch.calls).toEqual([]);
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

  test('an unknown package in pkg_downloads is an isError result starting not_found:', async () => {
    const { app, fetch } = testApp();
    client = await connectClient(app, '/mcp/pkg');
    const result = await client.callTool({ name: 'pkg_downloads', arguments: { package: 'edgr' } });
    expect(result.isError).toBe(true);
    expect(textOf(result).startsWith('not_found:')).toBe(true);
    expect(fetch.calls).toContain(statsPageUrl('workflows', 'edgr'));
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

describe('GET /api/v1/pkg/check_output', () => {
  const base = '/api/v1/pkg/check_output?universe=bioc&job=96299707840';

  test('returns the same envelope MCP returns as structuredContent', async () => {
    const { response, body } = await get(base);
    expect(response.status).toBe(200);
    expect(body.data.view).toBe('sections');
    expect(body.sources).toEqual([{ url: checksUrl('bioc', '96299707840'), as_of: '2026-10-22T12:00:00.000Z' }]);
    client = await connectClient(testApp().app, '/mcp/pkg');
    const result = await client.callTool({
      name: 'pkg_check_output',
      arguments: { universe: 'bioc', job: '96299707840' },
    });
    expect(result.isError).toBeFalsy();
    expect(body).toEqual(result.structuredContent);
  });

  test('full=true and offset reach the handler', async () => {
    const { response, body } = await get(
      '/api/v1/pkg/check_output?universe=bioc&job=91484882071&file=testthat.Rout.fail&full=true&offset=10',
    );
    expect(response.status).toBe(200);
    expect(body.data.view).toBe('page');
    expect(body.data.text.offset).toBe(10);
  });

  test.each(['abc', '0123', '1e5', '-1', '12%203', '..%2F1', '1%2F2', '', '1'.repeat(21)])(
    'job %j is 400 invalid_input with no fetch',
    async (job) => {
      const { response, body, fetch } = await get(`/api/v1/pkg/check_output?universe=bioc&job=${job}`);
      expect(response.status).toBe(400);
      expect(body.error.code).toBe('invalid_input');
      expect(fetch.calls).toEqual([]);
    },
  );

  test.each(['', '&universe=cran'])('universe %j is 400', async (universe) => {
    const { response, body } = await get(`/api/v1/pkg/check_output?job=96299707840${universe}`);
    expect(response.status).toBe(400);
    expect(body.error.code).toBe('invalid_input');
  });

  test('offset without full=true is 400; an offset past the end is 400', async () => {
    expect((await get(`${base}&file=testthat.Rout&offset=5`)).response.status).toBe(400);
    const { response } = await get(
      '/api/v1/pkg/check_output?universe=bioc&job=91484882071&file=testthat.Rout.fail&full=true&offset=6146',
    );
    expect(response.status).toBe(400);
  });

  test.each(['..%2F00check.log', 'constructor', '__proto__', '00check.log%2Fx'])(
    'file %j is 404 not_found, lists the files and requests only the checks URL',
    async (file) => {
      const { response, body, fetch } = await get(`${base}&file=${file}`);
      expect(response.status).toBe(404);
      expect(body.error.code).toBe('not_found');
      expect(body.error.message).toContain('Its files: 00check.log');
      expect(fetch.calls).toEqual([checksUrl('bioc', '96299707840')]);
    },
  );

  test('a job the registry has not captured is 404 not_found', async () => {
    const { response, body } = await get('/api/v1/pkg/check_output?universe=bioc&job=112702240220');
    expect(response.status).toBe(404);
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toContain('has no captured check output');
    expect(body.error.message).toContain('may not be captured yet or may never be');
    expect(body.error.message).toContain('https://github.com/r-universe/bioc/runs/112702240220');
  });
});

describe('GET /api/v1/pkg/build_environment', () => {
  const url =
    '/api/v1/pkg/build_environment?universe=bioc&job=96299707840&dependencies=biomaRt&dependencies=httr2';

  test('returns the same envelope MCP returns as structuredContent, with repeated dependencies', async () => {
    const { response, body, fetch } = await get(url);
    expect(response.status).toBe(200);
    expect(body.data.deps).toEqual([
      { package: 'biomaRt', version: '2.69.0', did_you_mean: [] },
      { package: 'httr2', version: '1.3.0', did_you_mean: [] },
    ]);
    expect(fetch.calls).toEqual([buildsUrl('bioc', '96299707840')]);
    client = await connectClient(testApp().app, '/mcp/pkg');
    const result = await client.callTool({
      name: 'pkg_build_environment',
      arguments: { universe: 'bioc', job: '96299707840', dependencies: ['biomaRt', 'httr2'] },
    });
    expect(result.isError).toBeFalsy();
    expect(body).toEqual(result.structuredContent);
  });

  test('a single dependencies parameter is a one-element list', async () => {
    const { body } = await get('/api/v1/pkg/build_environment?universe=bioc&job=96299707840&dependencies=httr2');
    expect(body.data.deps).toEqual([{ package: 'httr2', version: '1.3.0', did_you_mean: [] }]);
  });

  test('a bad job is 400 and a bad dependency name is 400, with no fetch', async () => {
    for (const path of [
      '/api/v1/pkg/build_environment?universe=bioc&job=0123',
      '/api/v1/pkg/build_environment?universe=bioc&job=96299707840&dependencies=a%2Fb',
    ]) {
      const { response, body, fetch } = await get(path);
      expect(response.status).toBe(400);
      expect(body.error.code).toBe('invalid_input');
      expect(fetch.calls).toEqual([]);
    }
  });

  test('a job without a manifest is 404 not_found naming the build manifest', async () => {
    const { response, body } = await get('/api/v1/pkg/build_environment?universe=bioc&job=112702240220');
    expect(response.status).toBe(404);
    expect(body.error.message).toContain('build manifest');
  });
});

describe('GET /api/v1/pkg/release_info', () => {
  test('returns the same envelope MCP returns as structuredContent', async () => {
    const { response, body } = await get('/api/v1/pkg/release_info');
    expect(response.status).toBe(200);
    expect(body.data.release.version).toBe('3.23');
    expect(body.sources).toHaveLength(2);
    client = await connectClient(testApp().app, '/mcp/pkg');
    const result = await client.callTool({ name: 'pkg_release_info', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(body).toEqual(result.structuredContent);
  });
});

describe('GET /api/v1/pkg/downloads', () => {
  test('returns the same envelope MCP returns as structuredContent', async () => {
    const { response, body } = await get('/api/v1/pkg/downloads?package=edgeR');
    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({ package: 'edgeR', category: 'bioc', year: 2026 });
    client = await connectClient(testApp().app, '/mcp/pkg');
    const result = await client.callTool({ name: 'pkg_downloads', arguments: { package: 'edgeR' } });
    expect(result.isError).toBeFalsy();
    expect(body).toEqual(result.structuredContent);
  });

  test('year=2025 selects that year', async () => {
    const { response, body, fetch } = await get('/api/v1/pkg/downloads?package=edgeR&year=2025');
    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({ year: 2025, year_requested: 2025 });
    expect(fetch.calls).toContain(statsTabUrl('bioc', 'edgeR', 2025));
  });

  test('an unknown package is 404 not_found naming the categories', async () => {
    const { response, body } = await get('/api/v1/pkg/downloads?package=edgr');
    expect(response.status).toBe(404);
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toContain('bioc, data-annotation, data-experiment, workflows');
    expect(body.error.message).toContain('case-sensitive');
  });

  test.each(["package=a'b", 'package=x', 'package=edgeR&year=2008', 'package=edgeR&year=2101', 'package=edgeR&year=2025.5', 'package=edgeR&year=abc'])(
    'invalid query %j is 400 invalid_input with no fetch',
    async (query) => {
      const { response, body, fetch } = await get(`/api/v1/pkg/downloads?${query}`);
      expect(response.status).toBe(400);
      expect(body.error.code).toBe('invalid_input');
      expect(fetch.calls).toEqual([]);
    },
  );
});

describe('GET /api/v1/pkg/repo_diff', () => {
  test('returns the same envelope MCP returns as structuredContent', async () => {
    const { response, body } = await get('/api/v1/pkg/repo_diff');
    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({ universe: 'bioc', bioconductor_version: '3.24', category: 'version_differs' });
    expect(body.sources).toHaveLength(6);
    client = await connectClient(testApp().app, '/mcp/pkg');
    const result = await client.callTool({ name: 'pkg_repo_diff', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(body).toEqual(result.structuredContent);
    expect(textOf(result)).toBe(body.summary);
  });

  test('the query parameters select repo, category and limit', async () => {
    const { response, body } = await get(
      '/api/v1/pkg/repo_diff?universe=bioc-release&repo=bioc&category=only_bioconductor&limit=10',
    );
    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({ universe: 'bioc-release', repo: 'bioc', total: 1 });
  });

  test('a cursor that is not digits is 400 invalid_input with no fetch', async () => {
    const { response, body, fetch } = await get('/api/v1/pkg/repo_diff?cursor=x');
    expect(response.status).toBe(400);
    expect(body.error.code).toBe('invalid_input');
    expect(fetch.calls).toEqual([]);
  });

  test('is listed in the OpenAPI document', async () => {
    const { body } = await get('/api/openapi.json');
    expect(body.paths['/api/v1/pkg/repo_diff'].get.operationId).toBe('pkg_repo_diff');
  });
});

describe('GET /api/v1/about', () => {
  test('lists the registry, both r-universe upstreams and bioconductor.org as used by pkg', async () => {
    const { response, body } = await get('/api/v1/about');
    expect(response.status).toBe(200);
    const about = AboutSchema.parse(body);
    for (const id of ['registry', 'r-universe-bioc', 'r-universe-bioc-release']) {
      expect(about.upstreams.find((u) => u.id === id)?.used_by).toEqual(['pkg']);
    }
    expect(about.upstreams.find((u) => u.id === 'bioconductor')).toMatchObject({
      base_url: 'https://bioconductor.org/',
      ttl_seconds: 3600,
      used_by: ['pkg'],
    });
    expect(about.modules.find((m) => m.name === 'pkg')?.tools).toEqual([
      'pkg_status',
      'pkg_check_output',
      'pkg_build_environment',
      'pkg_release_info',
      'pkg_downloads',
      'pkg_repo_diff',
    ]);
  });
});
