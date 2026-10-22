import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Deps } from '../../src/core/deps';
import { CapabilityError } from '../../src/errors';
import { createMemoryCache, type UpstreamCache } from '../../src/upstreams/cache';
import { getPropagationIndex, registryEntry } from '../../src/upstreams/registry';
import { fixtureFetch, type FixtureRoute } from '../support/fixture-fetch';
import { BIOC_INDEX_URL, pkgRoutes } from '../support/pkg-routes';

function makeDeps(routes: Record<string, FixtureRoute> = pkgRoutes) {
  const clock = { now: new Date('2026-10-22T12:00:00Z') };
  const now = () => clock.now;
  const inner = createMemoryCache(now);
  const gets: string[] = [];
  const cache: UpstreamCache = {
    async get(url) {
      gets.push(url);
      return inner.get(url);
    },
    put: (url, value, ttl) => inner.put(url, value, ttl),
  };
  const fetch = fixtureFetch(routes);
  const deps: Deps = { fetch, cache, now, env: {} };
  return { deps, fetch, gets, clock };
}

async function errorOf(promise: Promise<unknown>): Promise<CapabilityError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CapabilityError);
    return error as CapabilityError;
  }
  throw new Error('expected a CapabilityError');
}

describe('getPropagationIndex', () => {
  test('parses the index once per TTL: the second call touches neither cache nor fetch', async () => {
    const { deps, fetch, gets, clock } = makeDeps();
    const first = await getPropagationIndex(deps, 'bioc');
    expect(first.response.fromCache).toBe(false);
    expect(Object.keys(first.packages)).toContain('trackViewer');

    clock.now = new Date(clock.now.getTime() + 60_000);
    const second = await getPropagationIndex(deps, 'bioc');
    expect(second.packages).toBe(first.packages);
    expect(second.response.fromCache).toBe(true);
    expect(fetch.calls).toEqual([BIOC_INDEX_URL]);
    expect(gets).toEqual([BIOC_INDEX_URL]);
  });

  test('concurrent calls on a cold memo share one cache read, fetch and parse', async () => {
    const { deps, fetch, gets } = makeDeps();
    const [a, b] = await Promise.all([getPropagationIndex(deps, 'bioc'), getPropagationIndex(deps, 'bioc')]);
    expect(b.packages).toBe(a.packages);
    expect(fetch.calls).toEqual([BIOC_INDEX_URL]);
    expect(gets).toEqual([BIOC_INDEX_URL]);
  });

  test('concurrent calls after the TTL share one refresh', async () => {
    const { deps, fetch, clock } = makeDeps();
    await getPropagationIndex(deps, 'bioc');
    clock.now = new Date(clock.now.getTime() + 301_000);
    await Promise.all([getPropagationIndex(deps, 'bioc'), getPropagationIndex(deps, 'bioc')]);
    expect(fetch.calls).toEqual([BIOC_INDEX_URL, BIOC_INDEX_URL]);
  });

  test('a failed load is shared by concurrent callers but not cached', async () => {
    const routes: Record<string, FixtureRoute> = { [BIOC_INDEX_URL]: { status: 500 } };
    const { deps, fetch } = makeDeps(routes);
    const results = await Promise.allSettled([getPropagationIndex(deps, 'bioc'), getPropagationIndex(deps, 'bioc')]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(fetch.calls).toEqual([BIOC_INDEX_URL]);

    routes[BIOC_INDEX_URL] = pkgRoutes[BIOC_INDEX_URL]!;
    expect(Object.keys((await getPropagationIndex(deps, 'bioc')).packages)).toContain('trackViewer');
  });

  describe('a load that never settles', () => {
    afterEach(() => vi.useRealTimers());

    function hangingFirstFetch() {
      const { deps, fetch, clock } = makeDeps();
      const calls: string[] = [];
      deps.fetch = ((request: Request) => {
        calls.push(request.url);
        return calls.length === 1 ? new Promise<Response>(() => {}) : fetch(request);
      }) as Deps['fetch'];
      return { deps, calls, clock };
    }

    test('is replaced by the next caller once its deadline has passed', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { deps, calls, clock } = hangingFirstFetch();
      const stuck = getPropagationIndex(deps, 'bioc');
      const stuckSettled = errorOf(stuck);
      await vi.advanceTimersByTimeAsync(0);

      clock.now = new Date(clock.now.getTime() + 21_000);
      const fresh = await getPropagationIndex(deps, 'bioc');
      expect(Object.keys(fresh.packages)).toContain('trackViewer');
      expect(calls).toEqual([BIOC_INDEX_URL, BIOC_INDEX_URL]);

      await vi.advanceTimersByTimeAsync(21_000);
      expect((await stuckSettled).code).toBe('upstream_timeout');
      // the stuck owner must not evict the entry that replaced it
      expect((await getPropagationIndex(deps, 'bioc')).response.fromCache).toBe(true);
      expect(calls).toHaveLength(2);
    });

    test('fails the owner and every joined caller with upstream_timeout', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { deps, calls } = hangingFirstFetch();
      const owner = errorOf(getPropagationIndex(deps, 'bioc'));
      const joiner = errorOf(getPropagationIndex(deps, 'bioc'));
      await vi.advanceTimersByTimeAsync(20_000);
      expect([(await owner).code, (await joiner).code]).toEqual(['upstream_timeout', 'upstream_timeout']);

      // the failure is not cached: the next caller loads again
      expect(Object.keys((await getPropagationIndex(deps, 'bioc')).packages)).toContain('trackViewer');
      expect(calls).toEqual([BIOC_INDEX_URL, BIOC_INDEX_URL]);
    });
  });

  test('fetches again after the TTL', async () => {
    const { deps, fetch, clock } = makeDeps();
    const first = await getPropagationIndex(deps, 'bioc');
    clock.now = new Date(clock.now.getTime() + 301_000);
    const second = await getPropagationIndex(deps, 'bioc');
    expect(fetch.calls).toEqual([BIOC_INDEX_URL, BIOC_INDEX_URL]);
    expect(second.packages).not.toBe(first.packages);
    expect(second.response.fromCache).toBe(false);
  });

  test('two caches do not share a memo', async () => {
    const a = makeDeps();
    const b = makeDeps();
    await getPropagationIndex(a.deps, 'bioc');
    await getPropagationIndex(b.deps, 'bioc');
    expect(a.fetch.calls).toEqual([BIOC_INDEX_URL]);
    expect(b.fetch.calls).toEqual([BIOC_INDEX_URL]);
  });

  test('an index that is a JSON array is upstream_error', async () => {
    const { deps } = makeDeps({ [BIOC_INDEX_URL]: { status: 200, body: '[]' } });
    expect((await errorOf(getPropagationIndex(deps, 'bioc'))).code).toBe('upstream_error');
  });

  test('a missing index is upstream_error, not not_found', async () => {
    const { deps } = makeDeps({ [BIOC_INDEX_URL]: { status: 404 } });
    const error = await errorOf(getPropagationIndex(deps, 'bioc'));
    expect(error.code).toBe('upstream_error');
    expect(error.message).toContain('no propagation index for bioc');
  });
});

describe('registryEntry', () => {
  test('validates and returns a present entry', async () => {
    const { deps } = makeDeps();
    const entry = registryEntry(await getPropagationIndex(deps, 'bioc'), 'trackViewer');
    expect(entry).toMatchObject({ version: '1.49.3' });
  });

  test('returns undefined for an absent name, including Object.prototype names', async () => {
    const { deps } = makeDeps();
    const index = await getPropagationIndex(deps, 'bioc');
    expect(registryEntry(index, 'nope')).toBeUndefined();
    expect(registryEntry(index, 'constructor')).toBeUndefined();
  });

  test('an entry with the wrong shape is upstream_error', async () => {
    const { deps } = makeDeps({ [BIOC_INDEX_URL]: { status: 200, body: '{"bad":{"version":1}}' } });
    const index = await getPropagationIndex(deps, 'bioc');
    const error = await errorOf(Promise.resolve().then(() => registryEntry(index, 'bad')));
    expect(error.code).toBe('upstream_error');
    expect(error.message).toContain('unexpected shape');
  });
});
