import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Hono } from 'hono';
import { createApp } from '../../src/index';
import { metaModule } from '../../src/core/meta';
import { createMemoryCache } from '../../src/upstreams/cache';
import { exampleModule } from './example-module';
import { fixtureFetch, type FixtureRoute } from './fixture-fetch';

export const ALPHA_URL = 'https://upstream.test/items/alpha.json';
export const ALPHA_ROUTE: FixtureRoute = { file: 'example/items/alpha.json' };

export function makeTestApp(options: { routes?: Record<string, FixtureRoute>; now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date('2026-10-22T12:00:00Z'));
  const fetch = fixtureFetch(options.routes ?? { [ALPHA_URL]: ALPHA_ROUTE });
  const cache = createMemoryCache(now);
  const app = createApp({
    config: { allowedHosts: ['test.local'], allowedOrigins: ['test.local'] },
    modules: [metaModule, exampleModule],
    deps: { fetch, cache, now, env: {} },
  });
  return { app, fetch, cache };
}

/** Node's Request (and Hono's app.request) sends no Host header; the allowlist needs one. */
export function appFetch(app: Hono) {
  return (url: string | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(url, init);
    request.headers.set('host', new URL(request.url).host);
    return Promise.resolve(app.fetch(request));
  };
}

export async function connectClient(app: Hono, path: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://test.local' + path), { fetch: appFetch(app) }),
  );
  return client;
}
