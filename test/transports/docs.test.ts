import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, test } from 'vitest';
import { AboutSchema } from '../../src/core/about';
import { explainDecisionPrompt } from '../../src/core/docs/prompts';
import { modules, validateRegistry } from '../../src/core/registry';
import { opsModule } from '../../src/core/ops';
import { pkgModule } from '../../src/core/pkg';
import { connectClient, makeTestApp } from '../support/app';
import { docsTestModule } from '../support/docs';

const BASE = 'https://seandavi.github.io/bioc-infrastructure/';
const GATE = `${BASE}propagation-gate.html`;
const ADR9 = 'bioc://docs/adr/0009-client-addresses-are-hashed-at-the-edge.html';

let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

async function testApp() {
  return makeTestApp({ extraModules: [pkgModule, opsModule, await docsTestModule()] });
}

async function get(path: string) {
  const { app, fetch } = await testApp();
  const response = await app.fetch(new Request('http://test.local' + path));
  return { response, body: (await response.json()) as Record<string, any>, fetch };
}

async function connect(path: string) {
  const { app, fetch } = await testApp();
  client = await connectClient(app, path);
  return { client, fetch };
}

describe('registry', () => {
  test('the production registry contains docs and validates', () => {
    expect(() => validateRegistry(modules)).not.toThrow();
    expect(modules.map((m) => m.name)).toEqual(['meta', 'pkg', 'ops', 'docs']);
  });

  test('descriptions name only registered tools', async () => {
    const docs = await docsTestModule();
    const registered = new Set(modules.flatMap((m) => m.capabilities.map((c) => c.name)));
    const prefixes = new Set(modules.map((m) => m.name));
    for (const capability of docs.capabilities) {
      const tokens = capability.description.match(/\b[a-z]+_[a-z_]+\b/g) ?? [];
      expect(tokens.length).toBeGreaterThan(0);
      for (const token of tokens.filter((t) => prefixes.has(t.split('_')[0]!))) expect(registered.has(token)).toBe(true);
      expect(capability.description).toContain('pkg_status');
      expect(capability.description).toContain('ops_activity');
    }
    const [search, read] = docs.capabilities;
    expect(search!.description).toContain('docs_read');
    expect(read!.description).toContain('docs_search');
  });

  test('pkg and ops descriptions send design questions to docs_search', () => {
    const capabilities = modules.flatMap((m) => m.capabilities);
    for (const name of ['pkg_status', 'pkg_downloads', 'ops_activity']) {
      const capability = capabilities.find((c) => c.name === name)!;
      expect(capability.description.endsWith('(design, ADRs, runbooks) use docs_search.')).toBe(true);
    }
  });
});

describe('tools', () => {
  test('/mcp/docs lists exactly docs_read and docs_search, read-only, with outputSchema', async () => {
    const { client } = await connect('/mcp/docs');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['docs_read', 'docs_search']);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(Object.keys((tool.outputSchema as any).properties).sort()).toEqual(['data', 'sources', 'summary']);
    }
  });

  test('/mcp lists them alongside meta_ping, pkg_status and ops_activity', async () => {
    const { client } = await connect('/mcp');
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['docs_read', 'docs_search', 'meta_ping', 'pkg_status', 'ops_activity']));
  });

  test('docs_search structuredContent equals the REST body', async () => {
    const { response, body } = await get('/api/v1/docs/search?query=why+does+the+registry+poll&limit=5');
    expect(response.status).toBe(200);
    expect(body.data.hits).toHaveLength(5);
    const { client } = await connect('/mcp/docs');
    const result = await client.callTool({ name: 'docs_search', arguments: { query: 'why does the registry poll', limit: 5 } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(body);
  });

  test('docs_search carries freshness in structuredContent, text content and REST', async () => {
    const { client } = await connect('/mcp/docs');
    const result = await client.callTool({ name: 'docs_search', arguments: { query: 'why does the registry poll', limit: 3 } });
    const structured = result.structuredContent as { data: any; summary: string };
    expect(structured.data.freshness).toEqual({ index_built_at: '2026-10-22T00:00:00.000Z', index_age_days: 0, possibly_stale: [] });
    for (const hit of structured.data.hits) {
      expect(hit.as_of).toEqual(expect.any(String));
      expect(hit.source_commit).toMatch(/^[0-9a-f]{40}$/);
    }
    expect(structured.summary).toContain('Index built 2026-10-22 (0 days old).');
    const text = (result.content as { text: string }[]).map((block) => block.text).join('\n');
    expect(text).toContain('"freshness"');
  });

  test('docs_read structuredContent equals the REST body (fragment sent as %23)', async () => {
    const id = `${GATE}#why-the-registry-polls`;
    const { response, body } = await get(`/api/v1/docs/read?id_or_url=${encodeURIComponent(id)}`);
    expect(response.status).toBe(200);
    expect(body.data.kind).toBe('section');
    const { client } = await connect('/mcp/docs');
    const result = await client.callTool({ name: 'docs_read', arguments: { id_or_url: id } });
    expect(result.structuredContent).toEqual(body);
  });

  test('REST paginates docs_read with cursor', async () => {
    const url = encodeURIComponent(`${BASE}proposal-unified-search.html`);
    const first = (await get(`/api/v1/docs/read?id_or_url=${url}`)).body;
    expect(first.data.next_cursor).not.toBeNull();
    const second = (await get(`/api/v1/docs/read?id_or_url=${url}&cursor=${first.data.next_cursor}`)).body;
    expect(second.data.offset).toBe(Number(first.data.next_cursor));
  });

  test('an unknown URL is REST 404 not_found and MCP isError, with no outbound request', async () => {
    const unknown = `${BASE}propagation-gates.html`;
    const rest = await get(`/api/v1/docs/read?id_or_url=${encodeURIComponent(unknown)}`);
    expect(rest.response.status).toBe(404);
    expect(rest.body.error.code).toBe('not_found');
    expect(rest.body.error.message).toContain(GATE);
    expect(rest.fetch.calls).toEqual([]);

    const { client, fetch } = await connect('/mcp/docs');
    for (const id_or_url of [unknown, 'https://evil.example/x']) {
      const result = await client.callTool({ name: 'docs_read', arguments: { id_or_url } });
      expect(result.isError).toBe(true);
      expect((result.content as { text: string }[])[0]!.text.startsWith('not_found:')).toBe(true);
    }
    expect(fetch.calls).toEqual([]);
    const evil = await get(`/api/v1/docs/read?id_or_url=${encodeURIComponent('https://evil.example/x')}`);
    expect(evil.response.status).toBe(404);
    expect(evil.fetch.calls).toEqual([]);
  });

  test('limit=11 is REST 400 invalid_input', async () => {
    const { response, body } = await get('/api/v1/docs/search?query=registry&limit=11');
    expect(response.status).toBe(400);
    expect(body.error.code).toBe('invalid_input');
  });
});

describe('resources', () => {
  test('resources/templates/list has docs-page', async () => {
    const { client } = await connect('/mcp/docs');
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates).toEqual([
      expect.objectContaining({ name: 'docs-page', uriTemplate: 'bioc://docs/{+path}', mimeType: 'text/markdown' }),
    ]);
  });

  test('resources/list has bioc://about and one markdown entry per page', async () => {
    const { client } = await connect('/mcp/docs');
    const { resources } = await client.listResources();
    expect(resources.some((r) => r.uri === 'bioc://about')).toBe(true);
    const docs = resources.filter((r) => r.uri.startsWith('bioc://docs/'));
    expect(docs).toHaveLength(56);
    expect(docs.every((r) => r.mimeType === 'text/markdown')).toBe(true);
  });

  test('resources/list on /mcp/pkg is only bioc://about', async () => {
    const { client } = await connect('/mcp/pkg');
    expect((await client.listResources()).resources.map((r) => r.uri)).toEqual(['bioc://about']);
  });

  test('resources/read returns the whole page as markdown', async () => {
    const { client } = await connect('/mcp/docs');
    const { contents } = await client.readResource({ uri: ADR9 });
    const text = (contents[0] as { text: string }).text;
    expect(text.startsWith('# 0009 — Client addresses are hashed at the edge')).toBe(true);
    expect(text).toContain('## Decision');
    expect(text).toContain('adr/0009-client-addresses-are-hashed-at-the-edge.html#decision');
    expect(contents[0]).toMatchObject({ uri: ADR9, mimeType: 'text/markdown' });
  });

  test('resources/read of an unknown page fails with -32602 pointing at docs_search', async () => {
    const { client } = await connect('/mcp/docs');
    await expect(client.readResource({ uri: 'bioc://docs/nope.html' })).rejects.toMatchObject({
      code: -32602,
      message: expect.stringContaining('docs_search'),
    });
  });
});

describe('prompts', () => {
  test('explain-decision is listed on /mcp/docs and /mcp with one required topic argument', async () => {
    const expected = {
      '/mcp/docs': ['explain-decision'],
      '/mcp': ['explain-decision', 'triage-failing-package'],
    };
    for (const [path, names] of Object.entries(expected)) {
      const { client } = await connect(path);
      const { prompts } = await client.listPrompts();
      expect(prompts.map((p) => p.name).sort()).toEqual(names);
      const explain = prompts.find((p) => p.name === 'explain-decision');
      expect(explain!.arguments).toEqual([expect.objectContaining({ name: 'topic', required: true })]);
      await client.close();
    }
  });

  test.each(['/mcp/pkg', '/mcp/meta', '/mcp/example'])('explain-decision is absent on %s', async (path) => {
    const { client } = await connect(path);
    expect((await client.listPrompts()).prompts).toEqual([]);
  });

  test('prompts/get returns one user message naming the topic and tools', async () => {
    const { client } = await connect('/mcp/docs');
    const result = await client.getPrompt({ name: 'explain-decision', arguments: { topic: 'why are client addresses hashed' } });
    expect(result.messages).toHaveLength(1);
    const message = result.messages[0]!;
    expect(message.role).toBe('user');
    const text = (message.content as { text: string }).text;
    expect(text).toBe(explainDecisionPrompt.render({ topic: 'why are client addresses hashed' }));
    for (const part of ['why are client addresses hashed', 'docs_search', 'source "adr"', 'docs_read']) {
      expect(text).toContain(part);
    }
  });

  test('prompts/get without topic fails', async () => {
    const { client } = await connect('/mcp/docs');
    await expect(client.getPrompt({ name: 'explain-decision', arguments: {} })).rejects.toMatchObject({ code: -32602 });
  });
});

describe('about', () => {
  test('bioc://about and GET /api/v1/about carry the index warning from 2 days after the build, and not before', async () => {
    const warning = 'The docs index was built 2026-10-22, 2 days ago; it is rebuilt daily, so docs changed since then are not in it.';
    for (const [now, expected] of [
      ['2026-10-24T00:00:00Z', [warning]],
      ['2026-10-23T23:59:00Z', []],
    ] as const) {
      const { app } = makeTestApp({ extraModules: [pkgModule, opsModule, await docsTestModule()], now: () => new Date(now) });
      const rest = (await (await app.fetch(new Request('http://test.local/api/v1/about'))).json()) as any;
      expect(rest.datasets[0].possibly_stale).toEqual(expected);
      client = await connectClient(app, '/mcp/docs');
      const { contents } = await client.readResource({ uri: 'bioc://about' });
      expect(JSON.parse((contents[0] as { text: string }).text)).toEqual(rest);
      await client.close();
      client = undefined;
    }
  });

  test('bioc://about and GET /api/v1/about list the docs-index dataset', async () => {
    const { response, body } = await get('/api/v1/about');
    expect(response.status).toBe(200);
    const about = AboutSchema.parse(body);
    expect(about.datasets).toHaveLength(1);
    expect(about.datasets[0]).toMatchObject({ id: 'docs-index', module: 'docs' });
    const dataset = about.datasets[0]!;
    expect(dataset.inputs).toHaveLength(16);
    expect(dataset).toMatchObject({ age_days: 0, possibly_stale: [] });
    expect(dataset.inputs[0]!.commit).toMatchObject({
      repo: 'seandavi/bioc-infrastructure',
      ref: 'main',
      sha: '256fd62eab16312a6188bef6bf74ea2bbab5f830',
      url: 'https://github.com/seandavi/bioc-infrastructure/commit/256fd62eab16312a6188bef6bf74ea2bbab5f830',
    });
    for (const input of dataset.inputs) {
      expect(input.commit!.url).toBe(`https://github.com/${input.commit!.repo}/commit/${input.commit!.sha}`);
      expect(input.possibly_stale).toBeNull();
    }

    const { client } = await connect('/mcp/pkg');
    const { contents } = await client.readResource({ uri: 'bioc://about' });
    expect(JSON.parse((contents[0] as { text: string }).text)).toEqual(body);
  });
});
