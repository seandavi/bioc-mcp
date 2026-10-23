import { describe, expect, test } from 'vitest';
import type * as z from 'zod';
import type { Deps } from '../../../src/core/deps';
import { invokeCapability } from '../../../src/core/invoke';
import { pkgRevdeps, type PkgRevdepsDataSchema } from '../../../src/core/pkg/revdeps';
import { envelopeBytes, MAX_RESULT_BYTES, type Envelope } from '../../../src/envelope';
import { createMemoryCache } from '../../../src/upstreams/cache';
import { depsRoutes } from '../../support/deps-routes';
import { fixtureFetch, type FixtureRoute } from '../../support/fixture-fetch';
import { testContext } from '../../support/invoke-context';
import { BIOC_INDEX_URL } from '../../support/pkg-routes';

type Data = z.output<typeof PkgRevdepsDataSchema>;

const FETCHED_AT = '2026-10-22T12:00:00.000Z';
const NOT_IN_INDEX_SUMMARY_TAIL =
  ' Not counted: 1 package in the index without recorded dependencies (deps_unknown).';

function setup(routes: Record<string, FixtureRoute> = depsRoutes) {
  const fetch = fixtureFetch(routes);
  const now = () => new Date(FETCHED_AT);
  const deps: Deps = { fetch, cache: createMemoryCache(now), now, env: {} };
  return { fetch, deps };
}

async function run(input: Record<string, unknown>, routes?: Record<string, FixtureRoute>) {
  const { fetch, deps } = setup(routes);
  return { result: await invokeCapability(pkgRevdeps, input, deps, testContext()), fetch, deps };
}

async function revdeps(input: Record<string, unknown>, routes?: Record<string, FixtureRoute>) {
  const { result, fetch, deps } = await run(input, routes);
  if (!result.ok) throw result.error;
  const envelope = result.envelope as Envelope<Data>;
  return { envelope, data: envelope.data, fetch, deps };
}

const INDEX_SOURCE = { url: BIOC_INDEX_URL, as_of: FETCHED_AT };

describe('pkg_revdeps on the fixtures', () => {
  test('flowWorkspace, all levels', async () => {
    const { envelope, data, fetch } = await revdeps({ package: 'flowWorkspace' });
    expect(data).toMatchObject({
      package: 'flowWorkspace',
      universe: 'bioc',
      in_index: true,
      max_depth: null,
      counts: {
        direct: 10,
        direct_by_field: { depends: 3, imports: 7, linking_to: 1 },
        total: 16,
        by_depth: [
          { depth: 1, count: 10 },
          { depth: 2, count: 3 },
          { depth: 3, count: 2 },
          { depth: 4, count: 1 },
        ],
      },
      offset: 0,
      next_cursor: null,
      deps_unknown: ['easier'],
      deps_unknown_count: 1,
    });
    expect(data.dependents[0]).toEqual({
      depth: 1,
      names: ['CyFj11', 'CytoML', 'PeacoQC', 'flowGate', 'flowStats', 'ggcyto', 'highthroughputassays', 'openCyto', 'polyICSFlow', 'staRgate'],
    });
    expect(data.dependents.at(-1)).toEqual({ depth: 4, names: ['MDSvis'] });
    expect(data.dependents.map((g) => g.depth)).toEqual([1, 2, 3, 4]);
    expect(envelope.summary).toBe(
      'flowWorkspace (bioc): 16 packages in the propagation index depend on it through Depends, Imports or LinkingTo (10 directly).' +
        NOT_IN_INDEX_SUMMARY_TAIL,
    );
    expect(envelope.sources).toEqual([INDEX_SOURCE]);
    expect(fetch.calls).toEqual([BIOC_INDEX_URL]);
  });

  test('flowWorkspace, direct only', async () => {
    const all = await revdeps({ package: 'flowWorkspace' });
    const { data, envelope } = await revdeps({ package: 'flowWorkspace', depth: 1 });
    expect(data.max_depth).toBe(1);
    expect(data.counts.total).toBe(10);
    expect(data.counts.by_depth).toEqual([{ depth: 1, count: 10 }]);
    expect(data.dependents).toEqual([all.data.dependents[0]]);
    expect(envelope.summary).toContain('(10 directly; levels searched: 1).');
  });

  test('a mid-graph package: ggcyto', async () => {
    const { data } = await revdeps({ package: 'ggcyto' });
    expect(data.counts.direct).toBe(4);
    expect(data.dependents[0]).toEqual({ depth: 1, names: ['CompensAID', 'CytoML', 'CytoPipeline', 'flowGate'] });
    expect(data.counts.total).toBe(7);
    expect(data.dependents.at(-1)).toEqual({ depth: 3, names: ['MDSvis'] });
  });

  test('a leaf: MDSvis', async () => {
    const { data, envelope } = await revdeps({ package: 'MDSvis' });
    expect(data.in_index).toBe(true);
    expect(data.counts).toEqual({
      direct: 0,
      direct_by_field: { depends: 0, imports: 0, linking_to: 0 },
      total: 0,
      by_depth: [],
    });
    expect(data.dependents).toEqual([]);
    expect(envelope.summary).toBe(
      'MDSvis (bioc): no package in the propagation index depends on it through Depends, Imports or LinkingTo.' +
        NOT_IN_INDEX_SUMMARY_TAIL,
    );
  });

  test('a name not in the index: BiocSet', async () => {
    const { data, envelope } = await revdeps({ package: 'BiocSet' });
    expect(data.in_index).toBe(false);
    expect(data.counts.direct).toBe(3);
    expect(data.counts.direct_by_field).toEqual({ depends: 1, imports: 2, linking_to: 0 });
    expect(data.counts.total).toBe(3);
    expect(data.dependents).toEqual([{ depth: 1, names: ['RegEnrich', 'plaid', 'sparrow'] }]);
    expect(envelope.summary).toBe(
      'BiocSet (bioc): 3 packages in the propagation index depend on it through Depends, Imports or LinkingTo (3 directly). BiocSet itself is not in the index.' +
        NOT_IN_INDEX_SUMMARY_TAIL,
    );
  });

  test('an unknown name is not_found with a suggestion and the release hint', async () => {
    const { result, fetch } = await run({ package: 'flowWorkspac' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not_found');
    expect(result.error.message).toBe(
      'No bioc propagation entry named "flowWorkspac", and no package in the bioc index depends on it. Package names are case-sensitive.' +
        ' Did you mean: flowWorkspace?' +
        " To check release, call again with universe 'bioc-release'.",
    );
    expect(fetch.calls).toEqual([BIOC_INDEX_URL]);
  });

  test('a cursor past the end is invalid_input; cursor 0 on a leaf is fine', async () => {
    const past = await run({ package: 'flowWorkspace', cursor: '16' });
    expect(past.result.ok).toBe(false);
    if (!past.result.ok) {
      expect(past.result.error.code).toBe('invalid_input');
      expect(past.result.error.message).toContain('Call again without cursor.');
    }
    const leaf = await revdeps({ package: 'MDSvis', cursor: '0' });
    expect(leaf.data.counts.total).toBe(0);
  });

  test.each([
    { package: "a'b" },
    { package: 'x' },
    { package: 'flowWorkspace', depth: 0 },
    { package: 'flowWorkspace', depth: 21 },
    { package: 'flowWorkspace', depth: 1.5 },
    { package: 'flowWorkspace', cursor: 'abc' },
    { package: 'flowWorkspace', cursor: '-1' },
    { package: 'flowWorkspace', universe: 'cran' },
  ])('invalid input %j is rejected before any fetch', async (input) => {
    const { result, fetch } = await run(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_input');
    expect(fetch.calls).toEqual([]);
  });
});

function pad(prefix: string, n: number): string {
  return `${prefix}${String(n).padStart(4, '0')}`.padEnd(40, 'x');
}

const entry = (desc: Record<string, string>) => ({ version: '1.0.0', desc });

function syntheticIndexRoutes(): Record<string, FixtureRoute> {
  const index: Record<string, unknown> = { Hub: entry({}) };
  for (let i = 0; i < 2000; i++) index[pad('Dep', i)] = entry({ Imports: 'Hub' });
  for (let i = 0; i < 500; i++) index[pad('Sub', i)] = entry({ Imports: pad('Dep', 0) });
  return { [BIOC_INDEX_URL]: { status: 200, body: JSON.stringify(index) } };
}

describe('pkg_revdeps paging', () => {
  test('walking next_cursor returns every dependent once, in (depth, name) order, within the size limit', async () => {
    const routes = syntheticIndexRoutes();
    const { deps } = setup(routes);
    const seen: { depth: number; name: string }[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const result = await invokeCapability(pkgRevdeps, { package: 'Hub', cursor }, deps, testContext());
      if (!result.ok) throw result.error;
      const envelope = result.envelope as Envelope<Data>;
      expect(envelopeBytes(envelope)).toBeLessThanOrEqual(MAX_RESULT_BYTES);
      expect(envelope.data.counts.total).toBe(2500);
      for (const group of envelope.data.dependents) for (const name of group.names) seen.push({ depth: group.depth, name });
      pages++;
      if (envelope.data.next_cursor === null) break;
      cursor = envelope.data.next_cursor;
    }
    expect(pages).toBeGreaterThan(1);
    const expected = [
      ...Array.from({ length: 2000 }, (_, i) => ({ depth: 1, name: pad('Dep', i) })),
      ...Array.from({ length: 500 }, (_, i) => ({ depth: 2, name: pad('Sub', i) })),
    ];
    expect(seen).toEqual(expected);
  });

  test('a middle page says what it lists and how to continue', async () => {
    const { deps } = setup(syntheticIndexRoutes());
    const first = await invokeCapability(pkgRevdeps, { package: 'Hub' }, deps, testContext());
    if (!first.ok) throw first.error;
    const firstData = (first.envelope as Envelope<Data>).data;
    const cursor = firstData.next_cursor!;
    const shown = firstData.dependents.reduce((n, g) => n + g.names.length, 0);
    expect(cursor).toBe(String(shown));
    expect((first.envelope as Envelope<Data>).summary).toContain(
      ` Listed: 1–${shown} of 2500; call again with cursor "${cursor}" for the rest.`,
    );
    const second = await invokeCapability(pkgRevdeps, { package: 'Hub', cursor }, deps, testContext());
    if (!second.ok) throw second.error;
    const secondData = (second.envelope as Envelope<Data>).data;
    expect(secondData.offset).toBe(shown);
    const secondShown = secondData.dependents.reduce((n, g) => n + g.names.length, 0);
    expect((second.envelope as Envelope<Data>).summary).toContain(
      ` Listed: ${shown + 1}–${shown + secondShown} of 2500; call again with cursor "${shown + secondShown}" for the rest.`,
    );
  });

  test('the last page says Listed: a–total of total', async () => {
    const { deps } = setup(syntheticIndexRoutes());
    let cursor: string | undefined;
    let last: Envelope<Data> | undefined;
    do {
      const result = await invokeCapability(pkgRevdeps, { package: 'Hub', cursor }, deps, testContext());
      if (!result.ok) throw result.error;
      last = result.envelope as Envelope<Data>;
      cursor = last.data.next_cursor ?? undefined;
    } while (cursor !== undefined);
    expect(last!.summary).toContain(` Listed: ${last!.data.offset + 1}–2500 of 2500.`);
  });
});

describe('pkg_revdeps in bioc-release', () => {
  test('reads only the bioc-release index', async () => {
    const releaseUrl = 'https://bioc-registry.seandavi.workers.dev/data/prop/bioc-release/index.json';
    const routes = {
      [releaseUrl]: { status: 200, body: JSON.stringify({ AA: entry({}), BB: entry({ Depends: 'AA' }) }) },
    };
    const { data, fetch } = await revdeps({ package: 'AA', universe: 'bioc-release' }, routes);
    expect(data.universe).toBe('bioc-release');
    expect(data.dependents).toEqual([{ depth: 1, names: ['BB'] }]);
    expect(fetch.calls).toEqual([releaseUrl]);
  });

  test('not_found in release hints at devel', async () => {
    const releaseUrl = 'https://bioc-registry.seandavi.workers.dev/data/prop/bioc-release/index.json';
    const { result } = await run(
      { package: 'Zzzz', universe: 'bioc-release' },
      { [releaseUrl]: { status: 200, body: JSON.stringify({ AA: entry({}) }) } },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain(" To check devel, call again with universe 'bioc'.");
  });
});
