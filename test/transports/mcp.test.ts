import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, test } from 'vitest';
import { AboutSchema } from '../../src/core/about';
import { VERSION } from '../../src/version';
import { leakyModule } from '../support/leaky-module';
import { ALPHA_URL, appFetch, connectClient, makeTestApp } from '../support/app';

let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

async function toolNames(path: string): Promise<string[]> {
  client = await connectClient(makeTestApp().app, path);
  const { tools } = await client.listTools();
  await client.close();
  client = undefined;
  return tools.map((tool) => tool.name).sort();
}

function textOf(result: { content?: unknown }): string {
  const first = (result.content as { type: string; text?: string }[] | undefined)?.[0];
  return first?.text ?? '';
}

describe('toolsets', () => {
  test.each([
    ['/mcp', ['example_item', 'meta_ping']],
    ['/mcp/meta', ['meta_ping']],
    ['/mcp/example', ['example_item']],
    ['/mcp/example+meta', ['example_item', 'meta_ping']],
  ])('tools/list on %s', async (path, expected) => {
    expect(await toolNames(path)).toEqual(expected);
  });

  test.each([
    ['/mcp/nope', ['nope']],
    ['/mcp/meta+nope', ['nope']],
    ['/mcp/meta+', ['']],
  ])('%s is a 404 unknown_module', async (path, unknown) => {
    const { app } = makeTestApp();
    const response = await appFetch(app)('http://test.local' + path, { method: 'POST', body: '{}' });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string; unknown: string[]; valid: string[]; message: string } };
    expect(body.error.code).toBe('unknown_module');
    expect(body.error.valid).toEqual(['meta', 'example']);
    expect(body.error.unknown).toEqual(unknown);
    expect(body.error.message).toContain('Valid modules: meta, example');
  });
});

describe('tools', () => {
  test('every tool declares an outputSchema with data, summary and sources', async () => {
    client = await connectClient(makeTestApp().app, '/mcp');
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(2);
    for (const tool of tools) {
      expect(Object.keys(tool.outputSchema?.properties ?? {})).toEqual(
        expect.arrayContaining(['data', 'summary', 'sources']),
      );
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
  });

  test('meta_ping returns the envelope as structuredContent and the summary and data as text', async () => {
    client = await connectClient(makeTestApp().app, '/mcp');
    const result = await client.callTool({ name: 'meta_ping', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      data: { ok: true, version: VERSION },
      summary: `bioc-mcp ${VERSION} is up.`,
      sources: [],
    });
    expect(result.content).toEqual([
      { type: 'text', text: `bioc-mcp ${VERSION} is up.` },
      { type: 'text', text: JSON.stringify({ data: { ok: true, version: VERSION }, sources: [] }) },
    ]);
  });

  test('example_item returns data with provenance', async () => {
    client = await connectClient(makeTestApp().app, '/mcp');
    const result = await client.callTool({ name: 'example_item', arguments: { id: 'alpha' } });
    expect(result.structuredContent).toEqual({
      data: { id: 'alpha', title: 'Alpha item', body: 'Alpha item' },
      summary: 'Item alpha: Alpha item.',
      sources: [{ url: ALPHA_URL, as_of: '2026-10-01T00:00:00Z' }],
    });
    expect(JSON.parse((result.content as { text: string }[])[1]!.text)).toEqual({
      data: { id: 'alpha', title: 'Alpha item', body: 'Alpha item' },
      sources: [{ url: ALPHA_URL, as_of: '2026-10-01T00:00:00Z' }],
    });
  });

  test.each([
    ['404', { status: 404 } as const, 'not_found:'],
    ['500', { status: 500 } as const, 'upstream_error:'],
    ['timeout', 'timeout' as const, 'upstream_timeout:'],
    ['network failure', 'network-error' as const, 'upstream_error:'],
  ])('upstream %s becomes an isError result', async (_label, route, prefix) => {
    client = await connectClient(makeTestApp({ routes: { [ALPHA_URL]: route } }).app, '/mcp');
    const result = await client.callTool({ name: 'example_item', arguments: { id: 'alpha' } });
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(textOf(result).startsWith(prefix)).toBe(true);
  });

  test('a result over 8 KB becomes result_too_large', async () => {
    client = await connectClient(makeTestApp().app, '/mcp');
    const result = await client.callTool({ name: 'example_item', arguments: { id: 'alpha', repeat: 1000 } });
    expect(result.isError).toBe(true);
    expect(textOf(result).startsWith('result_too_large:')).toBe(true);
  });

  test('input that fails the schema is an isError result', async () => {
    client = await connectClient(makeTestApp().app, '/mcp');
    const result = await client.callTool({ name: 'example_item', arguments: { id: 'Bad Id' } });
    expect(result.isError).toBe(true);
    // SDK-owned wording (see buildMcpServer); REST reports the same failure as 400 invalid_input.
    expect(textOf(result)).toMatch(/^Input validation error: Invalid arguments for tool example_item:/);
  });
});

describe('bioc://about', () => {
  test('is listed and reads as AboutSchema JSON', async () => {
    client = await connectClient(makeTestApp().app, '/mcp/meta');
    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri)).toContain('bioc://about');
    const { contents } = await client.readResource({ uri: 'bioc://about' });
    const text = (contents[0] as { text: string }).text;
    const about = AboutSchema.parse(JSON.parse(text));
    // about describes every registered module, even when the toolset was narrowed to meta
    expect(about.modules.map((module) => module.name)).toEqual(['meta', 'example']);
    expect(about.upstreams[0]).toMatchObject({ id: 'example', ttl_seconds: 300, used_by: ['example'] });
  });
});

describe('Host and Origin validation', () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

  test('a Host outside the allowlist gets 403', async () => {
    const { app } = makeTestApp();
    const response = await app.fetch(
      new Request('http://evil.test/mcp', { method: 'POST', headers: { ...headers, host: 'evil.test' }, body }),
    );
    expect(response.status).toBe(403);
  });

  test('an Origin outside the allowlist gets 403', async () => {
    const { app } = makeTestApp();
    const response = await appFetch(app)('http://test.local/mcp', {
      method: 'POST',
      headers: { ...headers, origin: 'https://evil.test' },
      body,
    });
    expect(response.status).toBe(403);
  });

  test('an allowlisted Origin passes', async () => {
    const { app } = makeTestApp();
    const response = await appFetch(app)('http://test.local/mcp', {
      method: 'POST',
      headers: { ...headers, origin: 'https://test.local' },
      body,
    });
    expect(response.status).toBe(200);
  });

  test('REST routes ignore Host and Origin', async () => {
    const { app } = makeTestApp();
    const response = await app.fetch(
      new Request('http://evil.test/api/v1/meta/ping', { headers: { host: 'evil.test', origin: 'https://evil.test' } }),
    );
    expect(response.status).toBe(200);
  });
});

describe('legacy (2025-era) clients', () => {
  test('a plain tools/list POST is served as an event stream containing meta_ping', async () => {
    const { app } = makeTestApp();
    const response = await appFetch(app)('http://test.local/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(await response.text()).toContain('meta_ping');
  });
});

describe('output stripping', () => {
  test('structuredContent omits fields the data schema does not declare', async () => {
    client = await connectClient(makeTestApp({ extraModules: [leakyModule] }).app, '/mcp/leaky');
    const result = await client.callTool({ name: 'leaky_thing', arguments: {} });
    expect(result.structuredContent).toEqual({ data: { visible: 'yes' }, summary: 'Leaky.', sources: [] });
  });
});
