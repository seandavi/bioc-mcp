import type { Client } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Deps, FetchFn } from '../../../src/core/deps';
import { invokeCapability } from '../../../src/core/invoke';
import { opsActivity } from '../../../src/core/ops/activity';
import { opsModule } from '../../../src/core/ops';
import { createMemoryCache, type CachedUpstream } from '../../../src/upstreams/cache';
import { connectClient, makeTestApp } from '../../support/app';
import { fixtureFetch, type FixtureRoute } from '../../support/fixture-fetch';
import { GITHUB_RECORDED_AT, githubRoutes, githubUrl } from '../../support/github-routes';
import { testContext } from '../../support/invoke-context';

const SENTINEL = 'ghp_SENTINEL_0123456789abcdef';
const KINDS = ['summary', 'issues', 'prs', 'workflows', 'failures'] as const;
const ISSUES_SUFFIX = '/issues?state=open&per_page=100&sort=created&direction=desc';
const now = () => GITHUB_RECORDED_AT;

const consoleCalls: unknown[][] = [];
beforeEach(() => {
  consoleCalls.length = 0;
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleCalls.push(args);
    });
  }
});
let client: Client | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await client?.close();
  client = undefined;
});

/** A deps whose fetch records every Request's headers and whose cache records every put. */
function recordingDeps(routes: Record<string, FixtureRoute>, env: Deps['env'], fail?: 'timeout') {
  const requests: { url: string; headers: Headers }[] = [];
  const puts: CachedUpstream[] = [];
  const inner = fixtureFetch(routes);
  const fetch: FetchFn = (request) => {
    requests.push({ url: request.url, headers: new Headers(request.headers) });
    if (fail === 'timeout') return Promise.reject(new DOMException('timed out', 'TimeoutError'));
    return inner(request);
  };
  const base = createMemoryCache(now);
  const cache = {
    get: base.get,
    put: (url: string, value: CachedUpstream, ttl: number) => {
      puts.push(value);
      return base.put(url, value, ttl);
    },
  };
  return { deps: { fetch, cache, now, env } satisfies Deps, requests, puts };
}

function overridden(status: 'timeout' | 'network-error' | number): Record<string, FixtureRoute> {
  const route: FixtureRoute = typeof status === 'number' ? { status, body: status === 404 ? '{}' : 'oops' } : status;
  return Object.fromEntries(Object.keys(githubRoutes()).map((url) => [url, route]));
}

const leaks = (value: unknown) => JSON.stringify(value).includes(SENTINEL);

describe('with a token', () => {
  test.each(KINDS)('%s sends the token and headers on every request and leaks it nowhere', async (kind) => {
    const { deps, requests, puts } = recordingDeps(githubRoutes(), { GITHUB_TOKEN: SENTINEL });
    const result = await invokeCapability(opsActivity, { kind }, deps, testContext());
    expect(result.ok).toBe(true);
    expect(requests.length).toBeGreaterThan(0);
    for (const { url, headers } of requests) {
      expect(url.startsWith('https://api.github.com/repos/seandavi/')).toBe(true);
      expect(headers.get('authorization')).toBe(`Bearer ${SENTINEL}`);
      expect(headers.get('accept')).toBe('application/vnd.github+json');
      expect(headers.get('x-github-api-version')).toBe('2022-11-28');
      expect(headers.get('user-agent')).toMatch(/^bioc-mcp\//);
    }
    expect(leaks(result)).toBe(false);
    expect(leaks(puts)).toBe(false);
    expect(consoleCalls.map((args) => JSON.stringify(args)).join('')).not.toContain(SENTINEL);
  });

  test.each([401, 403, 404, 500, 'timeout', 'network-error'] as const)('a %s on every repo leaks nothing', async (status) => {
    for (const kind of KINDS) {
      const { deps, requests, puts } = recordingDeps(overridden(status), { GITHUB_TOKEN: SENTINEL }, status === 'timeout' ? 'timeout' : undefined);
      const result = await invokeCapability(opsActivity, { kind }, deps, testContext());
      expect(result.ok).toBe(false);
      expect(requests.every((r) => r.headers.get('authorization') === `Bearer ${SENTINEL}`)).toBe(true);
      expect(leaks(result)).toBe(false);
      expect(leaks(result.ok ? undefined : [result.error.message, result.error.details])).toBe(false);
      expect(leaks(puts)).toBe(false);
    }
    expect(consoleCalls.map((args) => JSON.stringify(args)).join('')).not.toContain(SENTINEL);
  });

  test('a partial failure leaks nothing', async () => {
    const routes = { ...githubRoutes(), [githubUrl('bioc-traffic', ISSUES_SUFFIX)]: { status: 500 } as FixtureRoute };
    const { deps } = recordingDeps(routes, { GITHUB_TOKEN: SENTINEL });
    const result = await invokeCapability(opsActivity, { kind: 'summary' }, deps, testContext());
    expect(result.ok).toBe(true);
    expect(leaks(result)).toBe(false);
  });

  test.each(KINDS)('REST and MCP %s bodies do not contain the token', async (kind) => {
    const { app } = makeTestApp({ routes: githubRoutes(), extraModules: [opsModule], env: { GITHUB_TOKEN: SENTINEL }, now });
    const rest = await app.fetch(new Request(`http://test.local/api/v1/ops/activity?kind=${kind}`));
    expect(rest.status).toBe(200);
    expect(await rest.text()).not.toContain(SENTINEL);
    client = await connectClient(app, '/mcp/ops');
    const mcp = await client.callTool({ name: 'ops_activity', arguments: { kind } });
    expect(leaks(mcp)).toBe(false);
    expect(consoleCalls.map((args) => JSON.stringify(args)).join('')).not.toContain(SENTINEL);
  });

  test.each([401, 403, 404, 500, 'timeout', 'network-error'] as const)('REST and MCP errors for a %s do not contain the token', async (status) => {
    const timingOut =
      status === 'timeout'
        ? Object.assign(() => Promise.reject(new DOMException('timed out', 'TimeoutError')), { calls: [] as string[] })
        : undefined;
    const { app } = makeTestApp({
      ...(timingOut ? { fetch: timingOut } : { routes: overridden(status) }),
      extraModules: [opsModule],
      env: { GITHUB_TOKEN: SENTINEL },
      now,
    });
    for (const kind of KINDS) {
      const rest = await app.fetch(new Request(`http://test.local/api/v1/ops/activity?kind=${kind}`));
      expect(rest.status).toBe(502);
      expect(await rest.text()).not.toContain(SENTINEL);
    }
    client = await connectClient(app, '/mcp/ops');
    const mcp = await client.callTool({ name: 'ops_activity', arguments: { kind: 'summary' } });
    expect(mcp.isError).toBe(true);
    expect(leaks(mcp)).toBe(false);
    expect(consoleCalls.map((args) => JSON.stringify(args)).join('')).not.toContain(SENTINEL);
  });
});

describe('without a token', () => {
  test('no request carries an authorization header, but the other headers are sent', async () => {
    for (const env of [{}, { GITHUB_TOKEN: '  ' }]) {
      const { deps, requests } = recordingDeps(githubRoutes(), env);
      expect((await invokeCapability(opsActivity, { kind: 'summary' }, deps, testContext())).ok).toBe(true);
      expect(requests.length).toBeGreaterThan(0);
      for (const { headers } of requests) {
        expect(headers.has('authorization')).toBe(false);
        expect(headers.get('accept')).toBe('application/vnd.github+json');
        expect(headers.get('x-github-api-version')).toBe('2022-11-28');
      }
    }
  });
});
