import { describe, expect, test } from 'vitest';
import type * as z from 'zod';
import type { Deps, FetchFn } from '../../../src/core/deps';
import { invokeCapability } from '../../../src/core/invoke';
import {
  MISSING_DEPS_NOT_CHECKED,
  pkgMissingDeps,
  type PkgMissingDepsDataSchema,
} from '../../../src/core/pkg/missing-deps';
import { envelopeBytes, MAX_RESULT_BYTES, type Envelope } from '../../../src/envelope';
import { createMemoryCache } from '../../../src/upstreams/cache';
import { biocDataUrl, CRAN_PACKAGES_URL, depsRoutes } from '../../support/deps-routes';
import { fixtureFetch, type FixtureRoute } from '../../support/fixture-fetch';
import { testContext } from '../../support/invoke-context';
import { BIOC_INDEX_URL, RELEASE_INDEX_URL } from '../../support/pkg-routes';

type Data = z.output<typeof PkgMissingDepsDataSchema>;

const START = Date.parse('2026-10-22T12:00:00Z');

function setup(routes: Record<string, FixtureRoute> = depsRoutes, wrap?: (inner: FetchFn) => FetchFn) {
  const clock = { ms: START };
  const inner = fixtureFetch(routes);
  const now = () => new Date(clock.ms);
  const deps: Deps = { fetch: wrap ? wrap(inner) : inner, cache: createMemoryCache(now), now, env: {} };
  return { fetch: inner, deps, clock };
}

async function run(input: Record<string, unknown>, routes?: Record<string, FixtureRoute>, wrap?: (inner: FetchFn) => FetchFn) {
  const { fetch, deps, clock } = setup(routes, wrap);
  return { result: await invokeCapability(pkgMissingDeps, input, deps, testContext()), fetch, deps, clock };
}

async function missingDeps(input: Record<string, unknown>, routes?: Record<string, FixtureRoute>) {
  const { result, fetch, deps, clock } = await run(input, routes);
  if (!result.ok) throw result.error;
  const envelope = result.envelope as Envelope<Data>;
  return { envelope, data: envelope.data, fetch, deps, clock };
}

const entry = (desc: Record<string, string>, extra: Record<string, unknown> = {}) => ({ version: '1.0.0', desc, ...extra });

const DEVEL_DATA_URLS = [
  CRAN_PACKAGES_URL,
  biocDataUrl('bioc', 'data/annotation'),
  biocDataUrl('bioc', 'data/experiment'),
];

describe('pkg_missing_deps on the fixtures (devel)', () => {
  test('lists the 11 affected packages and ranks their missing dependencies', async () => {
    const { envelope, data, fetch } = await missingDeps({});
    expect(data).toMatchObject({
      universe: 'bioc',
      packages_checked: 108,
      counts: { packages: 11, dependencies: 5 },
      offset: 0,
      next_cursor: null,
      deps_unknown: ['easier'],
      deps_unknown_count: 1,
    });
    expect(data.dependencies).toEqual([
      { name: 'decoupleR', needed_by: 5 },
      { name: 'BiocSet', needed_by: 3 },
      { name: 'SpatialExtremes', needed_by: 1 },
      { name: 'preseqR', needed_by: 1 },
      { name: 'pulsar', needed_by: 1 },
    ]);
    expect(data.packages.map((p) => p.package)).toEqual([
      'GSABenchmark',
      'RegEnrich',
      'SmartPhos',
      'SpiecEasi',
      'cosmosR',
      'pathMED',
      'plaid',
      'progeny',
      'scRecover',
      'sparrow',
      'synergyfinder',
    ]);
    const regEnrich = data.packages.find((p) => p.package === 'RegEnrich')!;
    expect(regEnrich.missing).toEqual([{ name: 'BiocSet', field: 'Depends' }]);
    expect(regEnrich.missing_count).toBe(1);
    expect(data.packages.map((p) => p.package)).not.toContain('ChIPXpress');
    expect(envelope.summary).toBe(
      '11 of 108 packages in the bioc propagation index have a hard dependency (Depends, Imports or LinkingTo) that is in none of: the index, base R, CRAN, Bioconductor annotation or experiment data.' +
        ' Most needed: decoupleR (5), BiocSet (3), SpatialExtremes (1), preseqR (1), pulsar (1).' +
        ' CRAN is matched by name only (best-effort); see not_checked.' +
        ' Not counted: 1 package in the index without recorded dependencies (deps_unknown).',
    );
    expect([...fetch.calls].sort()).toEqual([BIOC_INDEX_URL, ...DEVEL_DATA_URLS].sort());
  });

  test('the description says such packages likely cannot be installed from the registry', () => {
    expect(pkgMissingDeps.description).toContain("likely cannot be installed from the registry's repositories");
    expect(pkgMissingDeps.description).not.toContain('published but cannot be installed');
  });

  test('checked_against and not_checked', async () => {
    const { data } = await missingDeps({});
    expect(data.checked_against).toEqual([
      { source: 'registry_index', packages: 109 },
      { source: 'base_r', packages: 15 },
      { source: 'cran', packages: 186 }, // 200 Package: lines in the fixture, 14 of them repeats
      { source: 'bioc_data_annotation', packages: 1 },
      { source: 'bioc_data_experiment', packages: 2 },
    ]);
    expect(data.not_checked).toEqual([...MISSING_DEPS_NOT_CHECKED]);
  });

  test('sources, in order: index, CRAN, annotation, experiment', async () => {
    const { envelope } = await missingDeps({});
    expect(envelope.sources).toEqual([
      { url: BIOC_INDEX_URL, as_of: '2026-10-22T12:00:00.000Z' },
      { url: CRAN_PACKAGES_URL, as_of: '2026-10-22T23:51:28.000Z' },
      { url: biocDataUrl('bioc', 'data/annotation'), as_of: '2026-10-21T15:23:33.000Z' },
      { url: biocDataUrl('bioc', 'data/experiment'), as_of: '2026-10-22T21:31:29.000Z' },
    ]);
  });

  test.each([{ cursor: 'abc' }, { universe: 'x' }])('invalid input %j is rejected before any fetch', async (input) => {
    const { result, fetch } = await run(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_input');
    expect(fetch.calls).toEqual([]);
  });

  test('a cursor past the end is invalid_input', async () => {
    const { result } = await run({ cursor: '11' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid_input');
      expect(result.error.message).toContain('Call again without cursor.');
    }
  });
});

function indexRoutes(index: Record<string, unknown>, url = BIOC_INDEX_URL): Record<string, FixtureRoute> {
  return { ...depsRoutes, [url]: { status: 200, body: JSON.stringify(index) } };
}

describe('pkg_missing_deps on synthetic indexes', () => {
  test('nothing missing gives the "None of the" summary and no packages', async () => {
    const { data, envelope } = await missingDeps(
      {},
      indexRoutes({ AA: entry({ Imports: 'BB, stats, R (>= 4.0), GO.db, ChIPXpressData, MASS' }), BB: entry({}) }),
    );
    expect(data.packages).toEqual([]);
    expect(data.counts).toEqual({ packages: 0, dependencies: 0 });
    expect(data.dependencies).toEqual([]);
    expect(envelope.summary).toBe(
      'None of the 2 packages in the bioc propagation index has a hard dependency (Depends, Imports or LinkingTo) missing from the index, base R, CRAN and Bioconductor annotation and experiment data.' +
        ' CRAN is matched by name only (best-effort); see not_checked.',
    );
  });

  test('a seeded entry keeps its origin; an entry without origin reads as r-universe; a missing version is null', async () => {
    const { data } = await missingDeps(
      {},
      indexRoutes({
        Seeded: entry({ Imports: 'zzMissing' }, { origin: 'bioconductor' }),
        Plain: entry({ Imports: 'zzMissing' }),
        Gated: entry({ Imports: 'zzMissing' }, { origin: 'bioc-build', version: undefined }),
        Odd: entry({ Imports: 'zzMissing' }, { origin: 7 }),
      }),
    );
    const byName = Object.fromEntries(data.packages.map((p) => [p.package, p]));
    expect(byName.Seeded).toMatchObject({ origin: 'bioconductor', version: '1.0.0' });
    expect(byName.Plain).toMatchObject({ origin: 'r-universe', version: '1.0.0' });
    expect(byName.Gated).toMatchObject({ origin: 'bioc-build', version: null });
    expect(byName.Odd?.origin).toBe('r-universe');
  });

  test('each missing name is listed once, under the first field that names it', async () => {
    const { data } = await missingDeps(
      {},
      indexRoutes({ AA: entry({ LinkingTo: 'zzOne', Imports: 'zzOne, zzTwo', Depends: 'zzTwo' }) }),
    );
    expect(data.packages[0]!.missing).toEqual([
      { name: 'zzTwo', field: 'Depends' },
      { name: 'zzOne', field: 'Imports' },
    ]);
    expect(data.packages[0]!.missing_count).toBe(2);
  });

  test('a dependency on an own-property-named index key is found, a prototype name is not', async () => {
    const { data } = await missingDeps(
      {},
      indexRoutes({ AA: entry({ Imports: 'toString' }), toString: entry({}) }),
    );
    expect(data.counts.packages).toBe(0);
    const missing = await missingDeps({}, indexRoutes({ AA: entry({ Imports: 'valueOf' }) }));
    expect(missing.data.dependencies).toEqual([{ name: 'valueOf', needed_by: 1 }]);
  });

  test('walking next_cursor over 300 packages with 12 missing dependencies each', async () => {
    const index: Record<string, unknown> = {};
    for (let i = 0; i < 300; i++) {
      const missing = Array.from({ length: 12 }, (_, j) => `Missing${i}x${j}`.padEnd(40, 'x'));
      index[`Pkg${String(i).padStart(4, '0')}`] = entry({ Imports: missing.join(', ') });
    }
    const { deps } = setup(indexRoutes(index));
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const result = await invokeCapability(pkgMissingDeps, { cursor }, deps, testContext());
      if (!result.ok) throw result.error;
      const envelope = result.envelope as Envelope<Data>;
      expect(envelopeBytes(envelope)).toBeLessThanOrEqual(MAX_RESULT_BYTES);
      expect(envelope.data.counts).toEqual({ packages: 300, dependencies: 3600 });
      expect(envelope.data.dependencies).toHaveLength(20);
      for (const item of envelope.data.packages) {
        expect(item.missing).toHaveLength(10);
        expect(item.missing_count).toBe(12);
        seen.push(item.package);
      }
      pages++;
      if (envelope.data.next_cursor === null) break;
      cursor = envelope.data.next_cursor;
    }
    expect(pages).toBeGreaterThan(1);
    expect(seen).toEqual(Array.from({ length: 300 }, (_, i) => `Pkg${String(i).padStart(4, '0')}`));
  });
});

describe('pkg_missing_deps memo', () => {
  test('two calls within 3600 s make one CRAN request; after 3600 s, one more', async () => {
    const { deps, fetch, clock } = setup();
    const cranCalls = () => fetch.calls.filter((url) => url === CRAN_PACKAGES_URL).length;
    for (let i = 0; i < 2; i++) {
      const result = await invokeCapability(pkgMissingDeps, {}, deps, testContext());
      expect(result.ok).toBe(true);
    }
    expect(cranCalls()).toBe(1);
    clock.ms += 3600 * 1000;
    const again = await invokeCapability(pkgMissingDeps, {}, deps, testContext());
    expect(again.ok).toBe(true);
    expect(cranCalls()).toBe(2);
  });
});

describe('pkg_missing_deps upstream failures', () => {
  test.each([
    ['a CRAN 500', { status: 500, body: 'oops' } as FixtureRoute, 'upstream_error'],
    ['a CRAN 404', { status: 404, body: 'nope' } as FixtureRoute, 'upstream_error'],
    ['a CRAN body with no Package: line', { status: 200, body: 'Version: 1\n' } as FixtureRoute, 'upstream_error'],
  ])('%s fails the whole call', async (_label, route, code) => {
    const { result } = await run({}, { ...depsRoutes, [CRAN_PACKAGES_URL]: route });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });

  test('a CRAN fetch that times out is upstream_timeout', async () => {
    const { result } = await run({}, undefined, (inner) => (request) =>
      request.url === CRAN_PACKAGES_URL ? Promise.reject(new DOMException('timed out', 'TimeoutError')) : inner(request),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('upstream_timeout');
  });

  test('a data-repository 404 fails the whole call too', async () => {
    const { result } = await run(
      {},
      { ...depsRoutes, [biocDataUrl('bioc', 'data/experiment')]: { status: 404, body: 'nope' } },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('upstream_error');
  });
});

describe('pkg_missing_deps in bioc-release', () => {
  test('requests the release index and the release data lists', async () => {
    const routes: Record<string, FixtureRoute> = {
      ...depsRoutes,
      [RELEASE_INDEX_URL]: { status: 200, body: JSON.stringify({ AA: entry({ Imports: 'zzMissing, GO.db' }) }) },
      [biocDataUrl('bioc-release', 'data/annotation')]: depsRoutes[biocDataUrl('bioc', 'data/annotation')]!,
      [biocDataUrl('bioc-release', 'data/experiment')]: depsRoutes[biocDataUrl('bioc', 'data/experiment')]!,
    };
    const { data, fetch, envelope } = await missingDeps({ universe: 'bioc-release' }, routes);
    expect(data.universe).toBe('bioc-release');
    expect(data.dependencies).toEqual([{ name: 'zzMissing', needed_by: 1 }]);
    expect([...fetch.calls].sort()).toEqual(
      [
        RELEASE_INDEX_URL,
        CRAN_PACKAGES_URL,
        'https://bioconductor.org/packages/release/data/annotation/src/contrib/PACKAGES',
        'https://bioconductor.org/packages/release/data/experiment/src/contrib/PACKAGES',
      ].sort(),
    );
    expect(envelope.sources.map((s) => s.url)).toEqual([
      RELEASE_INDEX_URL,
      CRAN_PACKAGES_URL,
      'https://bioconductor.org/packages/release/data/annotation/src/contrib/PACKAGES',
      'https://bioconductor.org/packages/release/data/experiment/src/contrib/PACKAGES',
    ]);
  });
});
