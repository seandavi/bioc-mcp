import { describe, expect, test } from 'vitest';
import type * as z from 'zod';
import type { Deps } from '../../../src/core/deps';
import { invokeCapability } from '../../../src/core/invoke';
import {
  diffRepos,
  loadRepoDiff,
  pkgRepoDiff,
  type PkgRepoDiffDataSchema,
} from '../../../src/core/pkg/repo-diff';
import { envelopeBytes, MAX_RESULT_BYTES, type Envelope } from '../../../src/envelope';
import { CapabilityError } from '../../../src/errors';
import { BIOC_REPOS, type BiocRepo } from '../../../src/upstreams/bioconductor';
import { createMemoryCache } from '../../../src/upstreams/cache';
import { bioconductorRoutes, CONFIG_URL, packagesUrl, readBiocFixture } from '../../support/bioconductor-routes';
import { fixtureFetch, type FixtureRoute } from '../../support/fixture-fetch';
import { testContext } from '../../support/invoke-context';
import { BIOC_INDEX_URL, pkgRoutes, RELEASE_INDEX_URL } from '../../support/pkg-routes';

type Data = z.output<typeof PkgRepoDiffDataSchema>;
type Input = Parameters<typeof pkgRepoDiff.handler>[0];

const NOW = '2026-10-22T12:00:00.000Z';
const INDEX_URL = 'https://index.test/';

function makeDeps(routes: Record<string, FixtureRoute>, clock: { now: Date } = { now: new Date(NOW) }) {
  const now = () => clock.now;
  const fetch = fixtureFetch(routes);
  const deps: Deps = { fetch, cache: createMemoryCache(now), now, env: {} };
  return { deps, fetch, clock };
}

const fixtureRoutes = () => ({ ...pkgRoutes, ...bioconductorRoutes });

async function run(input: Partial<Input> = {}) {
  const { deps, fetch } = makeDeps(fixtureRoutes());
  const result = await invokeCapability(pkgRepoDiff, input, deps, testContext());
  return { result, fetch };
}

async function diff(input: Partial<Input> = {}) {
  const { result, fetch } = await run(input);
  if (!result.ok) throw result.error;
  const envelope = result.envelope as Envelope<Data>;
  return { envelope, data: envelope.data, fetch };
}

const names = (data: Data) => data.items.map((item) => item.package);

function files(versions: Partial<Record<BiocRepo, [string, string][]>>) {
  return BIOC_REPOS.map((repo) => ({ repo, versions: new Map(versions[repo] ?? []) }));
}

const entry = (version: string, origin?: string) => ({ version, ...(origin === undefined ? {} : { origin }) });

describe('diffRepos', () => {
  test('classifies each reason, the default origin and the other categories', () => {
    const result = diffRepos(
      {
        same: entry('1.0.0'),
        newer: entry('1.2.0', 'bioc-build'),
        seeded: entry('1.0.0', 'bioconductor'),
        gated: entry('1.0.0', 'r-universe'),
        gatedDefault: entry('1.0.0'),
        onlyRegistry: entry('3.0.0'),
      },
      files({
        bioc: [
          ['same', '1.0.0'],
          ['newer', '1.1.0'],
          ['seeded', '1.1.0'],
          ['gated', '1.1.0'],
          ['gatedDefault', '1.1.0'],
          ['onlyBioc', '2.0.0'],
        ],
      }),
      INDEX_URL,
    );
    expect(result.registryPackages).toBe(6);
    expect(result.lists.version_differs.map((i) => [i.package, i.reason, i.origin])).toEqual([
      ['gated', 'gated_behind', 'r-universe'],
      ['gatedDefault', 'gated_behind', 'r-universe'],
      ['newer', 'registry_newer', 'bioc-build'],
      ['seeded', 'seeded_behind', 'bioconductor'],
    ]);
    expect(result.lists.only_bioconductor).toEqual([
      { package: 'onlyBioc', repo: 'bioc', registry_version: null, bioconductor_version: '2.0.0', origin: null, reason: null },
    ]);
    expect(result.lists.only_registry).toEqual([
      { package: 'onlyRegistry', repo: null, registry_version: '3.0.0', bioconductor_version: null, origin: 'r-universe', reason: null },
    ]);
    expect(result.byRepo[0]).toEqual({
      repo: 'bioc',
      bioconductor_packages: 6,
      same_version: 1,
      version_differs: 4,
      only_bioconductor: 1,
    });
  });

  test.each([
    ['1.0', '1-0', 'cmp 0'],
    ['1.0a', '1.0', 'cmp null'],
    ['1.0', '1.0a', 'cmp null'],
  ])('%s vs %s (%s) is incomparable', (registry, bioconductor) => {
    const result = diffRepos({ pkg: entry(registry) }, files({ bioc: [['pkg', bioconductor]] }), INDEX_URL);
    expect(result.lists.version_differs.map((i) => i.reason)).toEqual(['incomparable']);
  });

  test('an index entry without version throws upstream_error naming the package and the index URL', () => {
    let error: unknown;
    try {
      diffRepos({ good: entry('1.0'), broken: { origin: 'r-universe' } }, files({}), INDEX_URL);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CapabilityError);
    expect((error as CapabilityError).code).toBe('upstream_error');
    expect((error as CapabilityError).message).toContain('broken');
    expect((error as CapabilityError).details.url).toBe(INDEX_URL);
  });

  test('a package in two repositories is counted and listed once per repository', () => {
    const result = diffRepos(
      { dup: entry('1.0') },
      files({ bioc: [['dup', '1.1']], books: [['dup', '1.0'], ['other', '1.0']] }),
      INDEX_URL,
    );
    expect(result.lists.version_differs.map((i) => [i.package, i.repo])).toEqual([['dup', 'bioc']]);
    expect(result.byRepo.map((r) => [r.repo, r.same_version, r.version_differs, r.only_bioconductor])).toEqual([
      ['bioc', 0, 1, 0],
      ['data-experiment', 0, 0, 0],
      ['workflows', 0, 0, 0],
      ['books', 1, 0, 1],
    ]);
    expect(result.lists.only_registry).toEqual([]);
  });

  test('an index key __proto__ is an ordinary name', () => {
    const packages = JSON.parse('{"__proto__": {"version": "1.0"}}') as Record<string, unknown>;
    const registryOnly = diffRepos(packages, files({}), INDEX_URL);
    expect(registryOnly.registryPackages).toBe(1);
    expect(registryOnly.lists.only_registry.map((i) => i.package)).toEqual(['__proto__']);
    const bothSides = diffRepos(packages, files({ bioc: [['__proto__', '1.0']] }), INDEX_URL);
    expect(bothSides.byRepo[0]!.same_version).toBe(1);
    // Absent from the index, an unrelated name must not find Object.prototype members.
    const absent = diffRepos({}, files({ bioc: [['constructor', '1.0']] }), INDEX_URL);
    expect(absent.lists.only_bioconductor.map((i) => i.package)).toEqual(['constructor']);
  });

  test('sorts case-insensitively, then by exact name, then by repository, in code-unit order', () => {
    const result = diffRepos(
      {},
      files({
        bioc: [['BP4RNAseq', '1.0'], ['Zeta', '1.0'], ['alpha', '1.0'], ['dup', '1.0']],
        'data-experiment': [['BeadArrayUseCases', '1.0'], ['Dup', '1.0']],
        books: [['dup', '1.0']],
      }),
      INDEX_URL,
    );
    expect(result.lists.only_bioconductor.map((i) => `${i.package}@${i.repo}`)).toEqual([
      'alpha@bioc',
      'BeadArrayUseCases@data-experiment',
      'BP4RNAseq@bioc',
      'Dup@data-experiment',
      'dup@bioc',
      'dup@books',
      'Zeta@bioc',
    ]);
  });

  test('counts add up on a generated index of 3,000 entries and 2,500 stanzas', () => {
    const packages: Record<string, unknown> = {};
    for (let i = 0; i < 3000; i++) packages[`pkg${i}`] = entry(`1.${i % 7}`);
    const perRepo: Partial<Record<BiocRepo, [string, string][]>> = {};
    let stanzas = 0;
    for (let i = 0; i < 2500; i++) {
      // Names 0–2,799 exist in the index (some at a different version); the rest only on bioconductor.org.
      const name = i < 2400 ? `pkg${i}` : `extra${i}`;
      const version = i % 5 === 0 ? '2.0' : `1.${i % 7}`;
      const repo = BIOC_REPOS[i % BIOC_REPOS.length]!;
      (perRepo[repo] ??= []).push([name, version]);
      stanzas++;
    }
    const result = diffRepos(packages, files(perRepo), INDEX_URL);
    for (const row of result.byRepo) {
      expect(row.same_version + row.version_differs + row.only_bioconductor).toBe(row.bioconductor_packages);
    }
    expect(result.byRepo.reduce((sum, r) => sum + r.bioconductor_packages, 0)).toBe(stanzas);
    const inBoth = new Set(
      Object.values(perRepo)
        .flat()
        .map(([name]) => name)
        .filter((name) => Object.hasOwn(packages, name)),
    );
    expect(inBoth.size + result.lists.only_registry.length).toBe(result.registryPackages);
    expect(result.registryPackages).toBe(3000);
  });
});

describe('pkg_repo_diff on the fixtures', () => {
  test('the default call compares devel with 3.24 across all four repositories', async () => {
    const { data, envelope } = await diff();
    expect(data.universe).toBe('bioc');
    expect(data.bioconductor_version).toBe('3.24');
    expect(data.repo).toBeNull();
    expect(data.counts).toEqual({
      registry_packages: 15,
      bioconductor_packages: 16,
      in_both: 12,
      same_version: 8,
      version_differs: 4,
      only_bioconductor: 4,
      only_registry: 3,
    });
    expect(data.version_differs_by_reason).toEqual({
      registry_newer: 2,
      seeded_behind: 1,
      gated_behind: 1,
      incomparable: 0,
    });
    expect(data.by_repo).toEqual([
      { repo: 'bioc', bioconductor_packages: 10, same_version: 6, version_differs: 3, only_bioconductor: 1 },
      { repo: 'data-experiment', bioconductor_packages: 2, same_version: 1, version_differs: 0, only_bioconductor: 1 },
      { repo: 'workflows', bioconductor_packages: 2, same_version: 0, version_differs: 1, only_bioconductor: 1 },
      { repo: 'books', bioconductor_packages: 2, same_version: 1, version_differs: 0, only_bioconductor: 1 },
    ]);
    expect(data.category).toBe('version_differs');
    expect(data.items).toEqual([
      { package: 'anndataR', repo: 'bioc', registry_version: '1.3.3', bioconductor_version: '1.3.2', origin: 'r-universe', reason: 'registry_newer' },
      { package: 'biomaRt', repo: 'bioc', registry_version: '2.69.0', bioconductor_version: '2.69.3', origin: 'bioconductor', reason: 'seeded_behind' },
      { package: 'Chromatograms', repo: 'bioc', registry_version: '1.3.3', bioconductor_version: '1.3.4', origin: 'r-universe', reason: 'gated_behind' },
      { package: 'methylationArrayAnalysis', repo: 'workflows', registry_version: '1.37.1', bioconductor_version: '1.37.0', origin: 'bioc-build', reason: 'registry_newer' },
    ]);
    expect([data.offset, data.total, data.next_cursor]).toEqual([0, 4, null]);
    expect(envelope.summary).toBe(
      'bioc (Bioconductor 3.24 devel) against bioconductor.org 3.24, all four repositories: 8 of 16 packages at the same version; ' +
        '4 differ (registry newer: 2, seeded behind: 1, gated behind: 1); 4 only on bioconductor.org; 3 only in the registry. ' +
        'Software (bioc): 6 of 10 at the same version. Showing version_differs 1–4 of 4.',
    );
  });

  test('only_bioconductor lists the packages the index lacks, with null registry fields', async () => {
    const { data } = await diff({ category: 'only_bioconductor' });
    expect(names(data)).toEqual(['BeadArrayUseCases', 'BP4RNAseq', 'csawBook', 'lipidr']);
    expect(data.items.map((i) => i.repo)).toEqual(['data-experiment', 'workflows', 'books', 'bioc']);
    for (const item of data.items) {
      expect([item.registry_version, item.origin, item.reason]).toEqual([null, null, null]);
      expect(item.bioconductor_version).not.toBeNull();
    }
  });

  test('only_registry lists index entries in none of the repositories', async () => {
    const { data } = await diff({ category: 'only_registry' });
    // GEOfastq is in the shared registry fixture for the triage prompt (#10) but in no PACKAGES fixture.
    expect(data.items).toEqual([
      { package: 'GEOfastq', repo: null, registry_version: '1.21.0', bioconductor_version: null, origin: 'r-universe', reason: null },
      { package: 'progeny', repo: null, registry_version: '1.35.0', bioconductor_version: null, origin: 'r-universe', reason: null },
      { package: 'TimerQuant', repo: null, registry_version: '1.43.0', bioconductor_version: null, origin: 'bioc-build', reason: null },
    ]);
  });

  test('repo narrows the counts and lists but not by_repo or only_registry', async () => {
    const { data, envelope } = await diff({ repo: 'bioc' });
    expect(data.repo).toBe('bioc');
    expect(data.counts).toEqual({
      registry_packages: 15,
      bioconductor_packages: 10,
      in_both: 9,
      same_version: 6,
      version_differs: 3,
      only_bioconductor: 1,
      only_registry: 3,
    });
    expect(data.by_repo).toHaveLength(4);
    expect(names(data)).toEqual(['anndataR', 'biomaRt', 'Chromatograms']);
    expect(envelope.summary).toContain('repository bioc');
    expect(envelope.summary).not.toContain('Software (bioc):');
    const registryOnly = await diff({ category: 'only_registry', repo: 'books' });
    expect(names(registryOnly.data)).toEqual(['GEOfastq', 'progeny', 'TimerQuant']);
  });

  test('pages with a cursor', async () => {
    const first = (await diff({ limit: 2 })).data;
    expect(names(first)).toEqual(['anndataR', 'biomaRt']);
    expect([first.offset, first.total, first.next_cursor]).toEqual([0, 4, '2']);
    const second = await diff({ limit: 2, cursor: first.next_cursor! });
    expect(names(second.data)).toEqual(['Chromatograms', 'methylationArrayAnalysis']);
    expect([second.data.offset, second.data.next_cursor]).toEqual([2, null]);
    expect(second.envelope.summary).toContain('Showing version_differs 3–4 of 4.');
    expect(first.next_cursor).toBe('2');
    const firstSummary = (await diff({ limit: 2 })).envelope.summary;
    expect(firstSummary).toContain('Showing version_differs 1–2 of 4; call again with cursor "2" for more.');
  });

  test.each(['4', '5'])('cursor %s is past the end of the 4-item list: invalid_input', async (cursor) => {
    const { result, fetch } = await run({ cursor });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid_input');
      expect(result.error.message).toContain(`cursor ${cursor} is past the end`);
    }
    expect(fetch.calls.length).toBeGreaterThan(0);
  });

  test('a cursor of 0 on an empty list is accepted', async () => {
    const { data } = await diff({ universe: 'bioc-release', category: 'only_registry', cursor: '0' });
    expect(data.items).toEqual([]);
  });

  test('an empty category returns no items and says so', async () => {
    const { data, envelope } = await diff({ universe: 'bioc-release', category: 'only_registry' });
    expect(data.items).toEqual([]);
    expect([data.total, data.next_cursor]).toEqual([0, null]);
    expect(envelope.summary.endsWith('No only_registry packages.')).toBe(true);
  });

  test('bioc-release fetches only 3.23 PACKAGES and the release index', async () => {
    const { data, envelope, fetch } = await diff({ universe: 'bioc-release' });
    expect(fetch.calls).toContain(RELEASE_INDEX_URL);
    expect(fetch.calls).not.toContain(BIOC_INDEX_URL);
    const packagesCalls = fetch.calls.filter((url) => url.includes('/src/contrib/PACKAGES'));
    expect(packagesCalls).toHaveLength(4);
    for (const url of packagesCalls) expect(url).toContain('/packages/3.23/');
    expect(data.bioconductor_version).toBe('3.23');
    expect(data.counts).toEqual({
      registry_packages: 1,
      bioconductor_packages: 5,
      in_both: 1,
      same_version: 1,
      version_differs: 0,
      only_bioconductor: 4,
      only_registry: 0,
    });
    expect(envelope.summary.startsWith('bioc-release (Bioconductor 3.23 release) against bioconductor.org 3.23')).toBe(true);
  });

  test('sources: index, config.yaml, then the four PACKAGES with their last-modified', async () => {
    const { envelope } = await diff();
    expect(envelope.sources).toEqual([
      { url: BIOC_INDEX_URL, as_of: NOW },
      { url: CONFIG_URL, as_of: '2026-08-01T15:44:12.000Z' },
      { url: packagesUrl('3.24', 'bioc'), as_of: '2026-10-22T17:01:01.000Z' },
      { url: packagesUrl('3.24', 'data/experiment'), as_of: '2026-10-22T21:31:29.000Z' },
      { url: packagesUrl('3.24', 'workflows'), as_of: '2026-10-13T21:27:41.000Z' },
      { url: packagesUrl('3.24', 'books'), as_of: '2026-10-19T19:25:22.000Z' },
    ]);
  });

  test('a second call makes no upstream request and shares the diff until the index expires', async () => {
    const { deps, fetch, clock } = makeDeps(fixtureRoutes());
    const first = await loadRepoDiff(deps, 'bioc');
    const calls = fetch.calls.length;
    const second = await loadRepoDiff(deps, 'bioc');
    expect(fetch.calls.length).toBe(calls);
    expect(second.diff).toBe(first.diff);

    clock.now = new Date(Date.parse(NOW) + 301_000);
    const third = await loadRepoDiff(deps, 'bioc');
    expect(third.diff).not.toBe(first.diff);
    expect(third.diff).toEqual(first.diff);
  });

  test('a PACKAGES 404 is an upstream_error naming the URL', async () => {
    const { deps } = makeDeps({
      ...fixtureRoutes(),
      [packagesUrl('3.24', 'books')]: { status: 404, body: 'Not Found' },
    });
    const result = await invokeCapability(pkgRepoDiff, {}, deps, testContext());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('upstream_error');
      expect(result.error.message).toContain(packagesUrl('3.24', 'books'));
    }
  });
});

describe('pkg_repo_diff size limit', () => {
  test('a page that would pass 8 KB is cut and next_cursor follows the cut', async () => {
    const pkgName = (i: number) => `pkg${String(i).padStart(2, '0')}${'x'.repeat(35)}`; // 40 characters
    const index: Record<string, unknown> = {};
    let packages = '';
    for (let i = 0; i < 50; i++) {
      expect(pkgName(i)).toHaveLength(40);
      index[pkgName(i)] = { version: '1.2.34567890124', origin: 'r-universe' };
      packages += `${i === 0 ? '' : '\n'}Package: ${pkgName(i)}\nVersion: 1.2.34567890123\n`;
    }
    const empty: FixtureRoute = { status: 200, body: '' };
    const { deps } = makeDeps({
      [BIOC_INDEX_URL]: { status: 200, body: JSON.stringify(index) },
      [CONFIG_URL]: { status: 200, body: readBiocFixture('config.yaml') },
      [packagesUrl('3.24', 'bioc')]: { status: 200, body: packages },
      [packagesUrl('3.24', 'data/experiment')]: empty,
      [packagesUrl('3.24', 'workflows')]: empty,
      [packagesUrl('3.24', 'books')]: empty,
    });
    const result = await invokeCapability(pkgRepoDiff, { limit: 50 }, deps, testContext());
    if (!result.ok) throw result.error;
    const envelope = result.envelope as Envelope<Data>;
    expect(envelopeBytes(envelope)).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(envelope.data.items.length).toBeGreaterThan(0);
    expect(envelope.data.items.length).toBeLessThan(50);
    expect(envelope.data.total).toBe(50);
    expect(envelope.data.next_cursor).toBe(String(envelope.data.items.length));
    expect(envelope.summary).toContain(`call again with cursor "${envelope.data.next_cursor}"`);
  });
});
