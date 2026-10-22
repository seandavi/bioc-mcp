import { describe, expect, test } from 'vitest';
import type { Deps } from '../../src/core/deps';
import { CapabilityError } from '../../src/errors';
import { createMemoryCache } from '../../src/upstreams/cache';
import { fetchUpstream, fetchUpstreamJson, pathSegment, sourceFor, USER_AGENT, type Upstream } from '../../src/upstreams/http';
import { exampleUpstream } from '../support/example-module';
import { fixtureFetch, type FixtureRoute } from '../support/fixture-fetch';

const ALPHA = 'https://upstream.test/items/alpha.json';
const ALPHA_ROUTE: FixtureRoute = { file: 'example/items/alpha.json' };

function makeDeps(routes: Record<string, FixtureRoute>, clock = { now: new Date('2026-10-22T12:00:00Z') }) {
  const fetch = fixtureFetch(routes);
  const now = () => clock.now;
  const deps: Deps = { fetch, cache: createMemoryCache(now), now, env: {} };
  return { deps, fetch, clock };
}

async function codeOf(promise: Promise<unknown>): Promise<CapabilityError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CapabilityError);
    return error as CapabilityError;
  }
  throw new Error('expected a CapabilityError');
}

describe('fetchUpstream', () => {
  test('returns the body, fetch time and no cache flag on a first fetch', async () => {
    const { deps } = makeDeps({ [ALPHA]: ALPHA_ROUTE });
    const response = await fetchUpstream(deps, exampleUpstream, 'items/alpha.json');
    expect(response.fromCache).toBe(false);
    expect(response.url).toBe(ALPHA);
    expect(JSON.parse(response.body)).toMatchObject({ id: 'alpha' });
    expect(response.fetchedAt).toBe('2026-10-22T12:00:00.000Z');
  });

  test('a second fetch within the TTL comes from the cache', async () => {
    const { deps, fetch } = makeDeps({ [ALPHA]: ALPHA_ROUTE });
    await fetchUpstream(deps, exampleUpstream, 'items/alpha.json');
    const second = await fetchUpstream(deps, exampleUpstream, 'items/alpha.json');
    expect(second.fromCache).toBe(true);
    expect(fetch.calls).toHaveLength(1);
  });

  test('refetches after the TTL', async () => {
    const { deps, fetch, clock } = makeDeps({ [ALPHA]: ALPHA_ROUTE });
    await fetchUpstream(deps, exampleUpstream, 'items/alpha.json');
    clock.now = new Date('2026-10-22T12:05:00Z'); // ttlSeconds is 300
    const again = await fetchUpstream(deps, exampleUpstream, 'items/alpha.json');
    expect(again.fromCache).toBe(false);
    expect(again.fetchedAt).toBe('2026-10-22T12:05:00.000Z');
    expect(fetch.calls).toHaveLength(2);
  });

  test('non-200 responses are not cached', async () => {
    const { deps, fetch } = makeDeps({ [ALPHA]: { status: 500 } });
    await codeOf(fetchUpstream(deps, exampleUpstream, 'items/alpha.json'));
    await codeOf(fetchUpstream(deps, exampleUpstream, 'items/alpha.json'));
    expect(fetch.calls).toHaveLength(2);
  });

  test('a 2xx other than 200 is returned but not cached', async () => {
    const { deps, fetch } = makeDeps({ [ALPHA]: { status: 203, body: '{}' } });
    const first = await fetchUpstream(deps, exampleUpstream, 'items/alpha.json');
    expect(first.fromCache).toBe(false);
    await fetchUpstream(deps, exampleUpstream, 'items/alpha.json');
    expect(fetch.calls).toHaveLength(2);
  });

  test('404 becomes not_found', async () => {
    const { deps } = makeDeps({ [ALPHA]: { status: 404 } });
    const error = await codeOf(fetchUpstream(deps, exampleUpstream, 'items/alpha.json'));
    expect(error.code).toBe('not_found');
    expect(error.message).toBe(`Example upstream has nothing at ${ALPHA}`);
  });

  test('500 becomes upstream_error with the status', async () => {
    const { deps } = makeDeps({ [ALPHA]: { status: 500 } });
    const error = await codeOf(fetchUpstream(deps, exampleUpstream, 'items/alpha.json'));
    expect(error.code).toBe('upstream_error');
    expect(error.message).toBe(`Example upstream returned HTTP 500 (${ALPHA}). Try again shortly.`);
    expect(error.details.status).toBe(500);
  });

  test('403 keeps the plain message without a retry hint', async () => {
    const { deps } = makeDeps({ [ALPHA]: { status: 403 } });
    const error = await codeOf(fetchUpstream(deps, exampleUpstream, 'items/alpha.json'));
    expect(error.code).toBe('upstream_error');
    expect(error.message).toBe('Example upstream returned HTTP 403');
    expect(error.details.status).toBe(403);
  });

  test('a timeout becomes upstream_timeout', async () => {
    const { deps } = makeDeps({ [ALPHA]: 'timeout' });
    const error = await codeOf(fetchUpstream(deps, exampleUpstream, 'items/alpha.json'));
    expect(error.code).toBe('upstream_timeout');
    expect(error.message).toBe(`Example upstream did not answer within 50 ms (${ALPHA}). Try again shortly.`);
  });

  test('a timeout while reading the body becomes upstream_timeout and caches nothing', async () => {
    const { deps } = makeDeps({});
    deps.fetch = async (request) =>
      new Response(
        new ReadableStream({
          start(controller) {
            request.signal.addEventListener('abort', () => controller.error(request.signal.reason), { once: true });
          },
        }),
      );
    const error = await codeOf(fetchUpstream(deps, exampleUpstream, 'items/alpha.json'));
    expect(error.code).toBe('upstream_timeout');
    expect(error.message).toBe(`Example upstream did not answer within 50 ms (${ALPHA}). Try again shortly.`);
    expect(await deps.cache.get(ALPHA)).toBeUndefined();
  });

  test('a body-read failure that is not a timeout becomes upstream_error', async () => {
    const { deps } = makeDeps({});
    deps.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError('terminated'));
          },
        }),
      );
    const error = await codeOf(fetchUpstream(deps, exampleUpstream, 'items/alpha.json'));
    expect(error.code).toBe('upstream_error');
    expect(error.message).toBe(`Could not read the response from Example upstream (${ALPHA}). Try again shortly.`);
  });

  test('a network failure becomes upstream_error', async () => {
    const { deps } = makeDeps({ [ALPHA]: 'network-error' });
    const error = await codeOf(fetchUpstream(deps, exampleUpstream, 'items/alpha.json'));
    expect(error.code).toBe('upstream_error');
    expect(error.message).toBe(`Could not reach Example upstream (${ALPHA}). Try again shortly.`);
  });

  test('sends the bioc-mcp User-Agent', async () => {
    const seen: string[] = [];
    const { deps } = makeDeps({});
    deps.fetch = async (request) => {
      seen.push(request.headers.get('user-agent') ?? '');
      return new Response('{}');
    };
    await fetchUpstream(deps, exampleUpstream, 'items/alpha.json');
    expect(seen).toEqual([USER_AGENT]);
    expect(USER_AGENT).toMatch(/^bioc-mcp\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/seandavi\/bioc-mcp\)$/);
  });

  describe('SSRF guard', () => {
    test.each([
      'http://upstream.test/',
      'https://upstream.test/api',
      'https://upstream.test/?q=1',
      'https://user:secret@upstream.test/',
    ])(
      'an unregistered upstream with an unsafe baseUrl (%s) throws internal without fetching',
      async (baseUrl) => {
        const { deps, fetch } = makeDeps({});
        const error = await codeOf(fetchUpstream(deps, { ...exampleUpstream, id: 'rogue', baseUrl }, 'items/alpha.json'));
        expect(error.code).toBe('internal');
        expect(error.message).not.toContain('secret');
        expect(fetch.calls).toEqual([]);
      },
    );

    const nested: Upstream = { ...exampleUpstream, id: 'nested', baseUrl: 'https://upstream.test/api/v1/' };

    test.each(['https://evil.test/', '//evil.test/x', 'http://upstream.test/items/alpha.json'])(
      'a path that leaves the origin (%s) throws internal without fetching',
      async (path) => {
        const { deps, fetch } = makeDeps({});
        const error = await codeOf(fetchUpstream(deps, exampleUpstream, path));
        expect(error.code).toBe('internal');
        expect(fetch.calls).toEqual([]);
      },
    );

    test.each(['../x', '../../etc/passwd', '/other/path'])(
      'a path that leaves the base path (%s) throws internal without fetching',
      async (path) => {
        const { deps, fetch } = makeDeps({});
        const error = await codeOf(fetchUpstream(deps, nested, path));
        expect(error.code).toBe('internal');
        expect(fetch.calls).toEqual([]);
      },
    );

    test.each(['https://evil.test/x', '//evil.test/x', 'http://upstream.test/items/moved.json', 'https://[bad'])(
      'a 302 to %s throws upstream_error after exactly one fetch and caches nothing',
      async (location) => {
        const { deps, fetch } = makeDeps({ [ALPHA]: { status: 302, headers: { location } } });
        const error = await codeOf(fetchUpstream(deps, exampleUpstream, 'items/alpha.json'));
        expect(error.code).toBe('upstream_error');
        expect(error.message).toBe('Example upstream redirected outside its base URL');
        expect(fetch.calls).toEqual([ALPHA]);
        expect(await deps.cache.get(ALPHA)).toBeUndefined();
      },
    );

    test('requests are built with redirect: manual', async () => {
      const modes: string[] = [];
      const { deps } = makeDeps({});
      deps.fetch = async (request) => {
        modes.push(request.redirect);
        return new Response('{}');
      };
      await fetchUpstream(deps, exampleUpstream, 'items/alpha.json');
      expect(modes).toEqual(['manual']);
    });

    test('a redirect that stays inside the base URL is followed and cached under the requested URL', async () => {
      const moved = 'https://upstream.test/items/moved.json';
      const { deps, fetch } = makeDeps({
        [ALPHA]: { status: 301, headers: { location: '/items/moved.json' } },
        [moved]: { status: 200, body: '{"id":"moved"}' },
      });
      const response = await fetchUpstream(deps, exampleUpstream, 'items/alpha.json');
      expect(response.fromCache).toBe(false);
      expect(JSON.parse(response.body)).toEqual({ id: 'moved' });
      expect(fetch.calls).toEqual([ALPHA, moved]);
      expect((await fetchUpstream(deps, exampleUpstream, 'items/alpha.json')).fromCache).toBe(true);
    });

    test('every hop is re-checked: an in-base redirect that then leaves the base stops there', async () => {
      const moved = 'https://upstream.test/items/moved.json';
      const { deps, fetch } = makeDeps({
        [ALPHA]: { status: 302, headers: { location: moved } },
        [moved]: { status: 302, headers: { location: 'https://evil.test/x' } },
      });
      const error = await codeOf(fetchUpstream(deps, exampleUpstream, 'items/alpha.json'));
      expect(error.message).toBe('Example upstream redirected outside its base URL');
      expect(fetch.calls).toEqual([ALPHA, moved]);
    });

    test('follows exactly 3 redirects', async () => {
      const hop = (n: number) => `https://upstream.test/hop${n}`;
      const { deps, fetch } = makeDeps({
        [ALPHA]: { status: 302, headers: { location: hop(1) } },
        [hop(1)]: { status: 302, headers: { location: hop(2) } },
        [hop(2)]: { status: 302, headers: { location: hop(3) } },
        [hop(3)]: { status: 200, body: '{}' },
      });
      const response = await fetchUpstream(deps, exampleUpstream, 'items/alpha.json');
      expect(response.fromCache).toBe(false);
      expect(fetch.calls).toEqual([ALPHA, hop(1), hop(2), hop(3)]);
    });

    test('follows at most 3 redirects', async () => {
      const hop = (n: number) => `https://upstream.test/hop${n}`;
      const { deps, fetch } = makeDeps({
        [ALPHA]: { status: 302, headers: { location: hop(1) } },
        [hop(1)]: { status: 302, headers: { location: hop(2) } },
        [hop(2)]: { status: 302, headers: { location: hop(3) } },
        [hop(3)]: { status: 302, headers: { location: hop(4) } },
        [hop(4)]: { status: 200, body: '{}' },
      });
      const error = await codeOf(fetchUpstream(deps, exampleUpstream, 'items/alpha.json'));
      expect(error.code).toBe('upstream_error');
      expect(error.message).toBe('Example upstream redirected more than 3 times');
      expect(fetch.calls).toEqual([ALPHA, hop(1), hop(2), hop(3)]);
    });

    test('a 3xx without a Location is an HTTP error', async () => {
      const { deps } = makeDeps({ [ALPHA]: { status: 302 } });
      const error = await codeOf(fetchUpstream(deps, exampleUpstream, 'items/alpha.json'));
      expect(error.message).toBe('Example upstream returned HTTP 302');
    });

    test('a path inside the base path is allowed', async () => {
      const { deps } = makeDeps({ 'https://upstream.test/api/v1/x': { status: 200, body: '{}' } });
      expect((await fetchUpstream(deps, nested, 'x')).url).toBe('https://upstream.test/api/v1/x');
    });
  });
});

describe('pathSegment', () => {
  test('percent-encodes an ordinary value', () => {
    expect(pathSegment('a b?c#d')).toBe('a%20b%3Fc%23d');
    expect(pathSegment('BiocGenerics')).toBe('BiocGenerics');
    expect(pathSegment('..a')).toBe('..a');
  });

  test.each([
    ['empty', ''],
    ['dot', '.'],
    ['dot-dot', '..'],
    ['forward slash', 'a/b'],
    ['leading slash', '/etc'],
    ['backslash', 'a\\b'],
    ['encoded dot', '%2e'],
    ['encoded dot, upper case', '%2E%2E'],
    ['encoded slash', 'a%2fb'],
    ['encoded slash, upper case', 'a%2Fb'],
  ])('rejects %s', (_label, value) => {
    try {
      pathSegment(value);
    } catch (error) {
      expect(error).toBeInstanceOf(CapabilityError);
      expect((error as CapabilityError).code).toBe('invalid_input');
      return;
    }
    throw new Error('expected a CapabilityError');
  });
});

describe('fetchUpstreamJson', () => {
  test('parses JSON', async () => {
    const { deps } = makeDeps({ [ALPHA]: ALPHA_ROUTE });
    const { json } = await fetchUpstreamJson(deps, exampleUpstream, 'items/alpha.json');
    expect(json).toMatchObject({ id: 'alpha', title: 'Alpha item' });
  });

  test('invalid JSON becomes upstream_error', async () => {
    const { deps } = makeDeps({ [ALPHA]: { status: 200, body: '<html>' } });
    const error = await codeOf(fetchUpstreamJson(deps, exampleUpstream, 'items/alpha.json'));
    expect(error.code).toBe('upstream_error');
    expect(error.message).toContain('not valid JSON');
  });
});

describe('sourceFor', () => {
  test('as_of is asOf, else Last-Modified, else the fetch time', async () => {
    const withHeader = makeDeps({
      [ALPHA]: { status: 200, body: '{}', headers: { 'last-modified': 'Tue, 01 Sep 2026 00:00:00 GMT' } },
    });
    const modified = await fetchUpstream(withHeader.deps, exampleUpstream, 'items/alpha.json');
    expect(modified.lastModified).toBe('2026-09-01T00:00:00.000Z');
    expect(sourceFor(modified)).toEqual({ url: ALPHA, as_of: '2026-09-01T00:00:00.000Z' });
    expect(sourceFor(modified, '2026-10-01')).toEqual({ url: ALPHA, as_of: '2026-10-01' });

    const bare = makeDeps({ [ALPHA]: ALPHA_ROUTE });
    const fetched = await fetchUpstream(bare.deps, exampleUpstream, 'items/alpha.json');
    expect(fetched.lastModified).toBeNull();
    expect(sourceFor(fetched)).toEqual({ url: ALPHA, as_of: '2026-10-22T12:00:00.000Z' });
  });

  test('an unparseable Last-Modified is ignored', async () => {
    const { deps } = makeDeps({ [ALPHA]: { status: 200, body: '{}', headers: { 'last-modified': 'yesterday-ish' } } });
    expect((await fetchUpstream(deps, exampleUpstream, 'items/alpha.json')).lastModified).toBeNull();
  });
});
