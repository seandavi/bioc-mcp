import type { Client } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, test } from 'vitest';
import { connectClient, makeTestApp } from '../support/app';

let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

describe('usage events per transport', () => {
  test('a REST capability call records one rest event', async () => {
    const { app, usage } = makeTestApp();
    const response = await app.fetch(new Request('http://test.local/api/v1/example/item?id=alpha'));
    expect(response.status).toBe(200);
    expect(usage.events).toEqual([
      { transport: 'rest', capability: 'example_item', latency_ms: 0, upstream_status: 200, ok: true, error_code: null },
    ]);
    expect(JSON.stringify(usage.events)).not.toContain('alpha');
  });

  test('GET /api/v1/about records nothing', async () => {
    const { app, usage } = makeTestApp();
    const response = await app.fetch(new Request('http://test.local/api/v1/about'));
    expect(response.status).toBe(200);
    expect(usage.events).toEqual([]);
  });

  test('only the valid MCP tools/call records an event', async () => {
    const { app, usage } = makeTestApp();
    client = await connectClient(app, '/mcp');
    await client.listTools();
    await client.readResource({ uri: 'bioc://about' });
    await client.callTool({ name: 'example_item', arguments: { id: 'alpha' } });
    await client.callTool({ name: 'example_item', arguments: { id: 'Bad Id' } });
    expect(usage.events).toEqual([
      { transport: 'mcp', capability: 'example_item', latency_ms: 0, upstream_status: 200, ok: true, error_code: null },
    ]);
    expect(JSON.stringify(usage.events)).not.toContain('alpha');
  });
});
