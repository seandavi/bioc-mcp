import * as z from 'zod';
import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, test } from 'vitest';
import { AboutSchema } from '../../src/core/about';
import { metaModule } from '../../src/core/meta';
import { exampleItem, exampleModule } from '../support/example-module';
import { queryToInput } from '../../src/transports/rest';
import { VERSION } from '../../src/version';
import { leakyModule } from '../support/leaky-module';
import { ALPHA_URL, connectClient, makeTestApp } from '../support/app';
import type { FixtureRoute } from '../support/fixture-fetch';

let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

async function get(path: string, routes?: Record<string, FixtureRoute>) {
  const { app } = makeTestApp(routes ? { routes } : {});
  const response = await app.fetch(new Request('http://test.local' + path));
  return { response, body: (await response.json()) as Record<string, any> };
}

describe('GET /api/v1/meta/ping', () => {
  test('returns the same envelope MCP returns as structuredContent', async () => {
    const { response, body } = await get('/api/v1/meta/ping');
    expect(response.status).toBe(200);
    expect(body).toEqual({ data: { ok: true, version: VERSION }, summary: `bioc-mcp ${VERSION} is up.`, sources: [] });
    client = await connectClient(makeTestApp().app, '/mcp');
    const result = await client.callTool({ name: 'meta_ping', arguments: {} });
    expect(body).toEqual(result.structuredContent);
  });
});

describe('GET /api/v1/example/item', () => {
  test('coerces the query string: repeat=2 is the integer 2', async () => {
    const { response, body } = await get('/api/v1/example/item?id=alpha&repeat=2');
    expect(response.status).toBe(200);
    expect(body.data.body).toBe('Alpha itemAlpha item');
    expect(body.sources).toEqual([{ url: ALPHA_URL, as_of: '2026-10-01T00:00:00Z' }]);
  });

  test('applies the schema default when repeat is absent', async () => {
    const { body } = await get('/api/v1/example/item?id=alpha');
    expect(body.data.body).toBe('Alpha item');
  });

  test.each(['/api/v1/example/item', '/api/v1/example/item?id=alpha&repeat=abc', '/api/v1/example/item?id=Bad%20Id'])(
    '%s is 400 invalid_input',
    async (path) => {
      const { response, body } = await get(path);
      expect(response.status).toBe(400);
      expect(body.error.code).toBe('invalid_input');
    },
  );

  test.each([
    ['upstream 404', { status: 404 } as const, 404, 'not_found'],
    ['upstream 500', { status: 500 } as const, 502, 'upstream_error'],
    ['timeout', 'timeout' as const, 502, 'upstream_timeout'],
    ['network failure', 'network-error' as const, 502, 'upstream_error'],
  ])('%s maps to %i %s', async (_label, route, status, code) => {
    const { response, body } = await get('/api/v1/example/item?id=alpha', { [ALPHA_URL]: route });
    expect(response.status).toBe(status);
    expect(body.error.code).toBe(code);
    expect(typeof body.error.message).toBe('string');
  });

  test('a result over 8 KB is a 500 result_too_large', async () => {
    const { response, body } = await get('/api/v1/example/item?id=alpha&repeat=1000');
    expect(response.status).toBe(500);
    expect(body.error.code).toBe('result_too_large');
  });
});

describe('GET /api/v1/leaky/thing', () => {
  test('does not return fields the data schema does not declare', async () => {
    const { app } = makeTestApp({ extraModules: [leakyModule] });
    const response = await app.fetch(new Request('http://test.local/api/v1/leaky/thing'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { visible: 'yes' }, summary: 'Leaky.', sources: [] });
  });
});

describe('GET /api/openapi.json', () => {
  test('is OpenAPI 3.1 and documents every route', async () => {
    const { response, body } = await get('/api/openapi.json');
    expect(response.status).toBe(200);
    expect(body.openapi).toBe('3.1.0');
    expect(body.info.version).toBe(VERSION);
    expect(Object.keys(body.paths).sort()).toEqual(['/api/v1/about', '/api/v1/example/item', '/api/v1/meta/ping']);
    const item = body.paths['/api/v1/example/item'].get;
    expect(item.operationId).toBe('example_item');
    const repeat = item.parameters.find((p: { name: string }) => p.name === 'repeat');
    expect(repeat.in).toBe('query');
    expect(repeat.schema).toMatchObject({ type: 'integer', default: 1 });
    expect(Object.keys(item.responses).sort()).toEqual(['200', '400', '404', '429', '500', '502']);
    expect(body.paths['/api/v1/meta/ping'].get.operationId).toBe('meta_ping');
    expect(body.paths['/api/v1/meta/ping'].get.responses['429']).toBeDefined();
    expect(body.paths['/api/v1/about'].get.responses['429']).toBeDefined();
    expect(body.tags).toEqual([
      { name: 'meta', description: metaModule.description },
      { name: 'example', description: exampleModule.description },
    ]);
  });
});

describe('GET /api/v1/about', () => {
  test('equals the bioc://about resource and parses with AboutSchema', async () => {
    const { response, body } = await get('/api/v1/about');
    expect(response.status).toBe(200);
    AboutSchema.parse(body);
    client = await connectClient(makeTestApp().app, '/mcp');
    const { contents } = await client.readResource({ uri: 'bioc://about' });
    expect(body).toEqual(JSON.parse((contents[0] as { text: string }).text));
    expect(body.upstreams[0]).toMatchObject({ id: 'example', ttl_seconds: 300, used_by: ['example'] });
  });
});

describe('unknown routes', () => {
  test('are a JSON 404 not_found', async () => {
    const { response, body } = await get('/nope');
    expect(response.status).toBe(404);
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toContain('GET /nope');
  });
});

describe('queryToInput', () => {
  const input = exampleItem.input;

  test('coerces numbers and leaves strings', () => {
    expect(queryToInput(input, new URLSearchParams('id=a&repeat=3'))).toEqual({ id: 'a', repeat: 3 });
  });

  test('ignores unknown parameters and omits absent ones', () => {
    expect(queryToInput(input, new URLSearchParams('zzz=1'))).toEqual({});
  });

  test('an empty number stays an empty string so validation reports it', () => {
    expect(queryToInput(input, new URLSearchParams('repeat='))).toEqual({ repeat: '' });
  });

  test('uses the last value of a repeated scalar', () => {
    expect(queryToInput(input, new URLSearchParams('id=a&id=b'))).toEqual({ id: 'b' });
  });

  test('coerces arrays item by item and booleans by name', () => {
    const rich = z.object({ ids: z.array(z.number()), flag: z.boolean(), odd: z.boolean() });
    expect(queryToInput(rich, new URLSearchParams('ids=1&ids=2&flag=true&odd=maybe'))).toEqual({
      ids: [1, 2],
      flag: true,
      odd: 'maybe',
    });
  });
});
