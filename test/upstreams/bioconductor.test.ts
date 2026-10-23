import { describe, expect, test } from 'vitest';
import type { Deps } from '../../src/core/deps';
import { CapabilityError } from '../../src/errors';
import { createMemoryCache } from '../../src/upstreams/cache';
import {
  biocDataRepoPath,
  bioconductorUpstream,
  findStatsPage,
  getBiocConfig,
  getBiocDataPackagesFile,
  getBiocPackagesFile,
  getManifestIndex,
  getStatsTab,
  packagesPath,
  parseDataAsOf,
  parseStatsTab,
  parseStatsYears,
} from '../../src/upstreams/bioconductor';
import { parsePackagesFile } from '../../src/upstreams/packages-file';
import {
  bioconductorRoutes,
  CONFIG_URL,
  MANIFEST_URL,
  NOT_FOUND,
  packagesUrl,
  readBiocFixture,
  statsPageUrl,
  statsTabUrl,
} from '../support/bioconductor-routes';
import { biocDataUrl, depsRoutes } from '../support/deps-routes';
import { fixtureFetch, type FixtureRoute } from '../support/fixture-fetch';

const EDGER_PAGE = readBiocFixture('packages/stats/bioc/edgeR/index.html');
const EDGER_2026 = readBiocFixture('packages/stats/bioc/edgeR/edgeR_2026_stats.tab');

function makeDeps(extra: Record<string, FixtureRoute> = {}) {
  const now = () => new Date('2026-10-22T12:00:00Z');
  const fetch = fixtureFetch({ ...bioconductorRoutes, ...extra });
  const deps: Deps = { fetch, cache: createMemoryCache(now), now, env: {} };
  return { deps, fetch };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CapabilityError);
    return (error as CapabilityError).code;
  }
  throw new Error('expected a CapabilityError');
}

describe('parseDataAsOf', () => {
  test.each([
    [EDGER_PAGE, '2026-10-22'],
    ['<I>Data as of Thu. 22 Oct 2026.</I>', '2026-10-22'],
    ['Data as of 5 Jan 2027', '2027-01-05'],
    ['Data as of Thu. 31 Feb 2026', null],
    ['Data as of 22 Okt 2026', null],
    ['<html>no date here</html>', null],
  ])('%#', (html, expected) => {
    expect(parseDataAsOf(html)).toBe(expected);
  });
});

describe('parseStatsYears', () => {
  test('the edgeR page lists 2009 to 2026, ascending', () => {
    const years = parseStatsYears(EDGER_PAGE, 'edgeR');
    expect(years).toHaveLength(18);
    expect(years[0]).toBe(2009);
    expect(years.at(-1)).toBe(2026);
    expect(years).toEqual([...years].sort((a, b) => a - b));
  });

  test('links for another name and the all-years file are ignored', () => {
    const html = '<a href="edgeR2_2020_stats.tab"><a href="edgeR_stats.tab"><a href="edgeR_2021_stats.tab">';
    expect(parseStatsYears(html, 'edgeR')).toEqual([2021]);
  });

  test('a name with dots matches only itself', () => {
    const html = '<a href="orgXHsXegXdb_2020_stats.tab"><a href="org.Hs.eg.db_2021_stats.tab">';
    expect(parseStatsYears(html, 'org.Hs.eg.db')).toEqual([2021]);
  });
});

describe('parseStatsTab', () => {
  const URL = statsTabUrl('bioc', 'edgeR', 2026);
  const rows = EDGER_2026.split('\n');

  test('the 2026 fixture gives 12 months in order and the yearly total', () => {
    const tab = parseStatsTab(EDGER_2026, 2026, URL);
    expect(tab.months.map((m) => m.month)).toEqual(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
    expect(tab.months[0]).toEqual({ month: 'Jan', distinct_ips: 28941, downloads: 53538 });
    expect(tab.months[11]).toEqual({ month: 'Dec', distinct_ips: 0, downloads: 0 });
    expect(tab.total).toEqual({ distinct_ips: 235261, downloads: 723176 });
  });

  test('a shuffled row order still comes back in calendar order', () => {
    const shuffled = [rows[0]!, ...rows.slice(1).reverse()].join('\n');
    expect(parseStatsTab(shuffled, 2026, URL)).toEqual(parseStatsTab(EDGER_2026, 2026, URL));
  });

  test('\\r\\n line endings parse', () => {
    expect(parseStatsTab(EDGER_2026.replaceAll('\n', '\r\n') + '\r\n', 2026, URL).total.downloads).toBe(723176);
  });

  test.each([
    ['a wrong header', EDGER_2026.replace('Nb_of_downloads', 'Downloads')],
    ['a missing month', [rows[0], ...rows.slice(2)].join('\n')],
    ['a duplicate month', [...rows.slice(0, 12), rows[1], rows[13]].join('\n')],
    ['a wrong year', EDGER_2026.replace('2026\tJan', '2025\tJan')],
    ['a non-numeric count', EDGER_2026.replace('28941', 'many')],
    ['a five-field row', EDGER_2026.replace('2026\tJan\t', '2026\tJan\t1\t')],
    ['a missing all row', rows.slice(0, 13).join('\n')],
  ])('%s is upstream_error', (_label, body) => {
    expect(() => parseStatsTab(body, 2026, URL)).toThrowError(
      expect.objectContaining({ code: 'upstream_error', details: { upstream: 'bioconductor', url: URL } }),
    );
  });
});

describe('findStatsPage', () => {
  test('edgeR is in bioc with one request', async () => {
    const { deps, fetch } = makeDeps();
    const page = await findStatsPage(deps, 'edgeR');
    expect(page).toMatchObject({ category: 'bioc', url: statsPageUrl('bioc', 'edgeR'), dataAsOf: '2026-10-22' });
    expect(page?.years).toHaveLength(18);
    expect(fetch.calls).toEqual([statsPageUrl('bioc', 'edgeR')]);
  });

  test('rnaseqGene takes four requests in category order', async () => {
    const { deps, fetch } = makeDeps();
    const page = await findStatsPage(deps, 'rnaseqGene');
    expect(page?.category).toBe('workflows');
    expect(fetch.calls).toEqual([
      statsPageUrl('bioc', 'rnaseqGene'),
      statsPageUrl('data-annotation', 'rnaseqGene'),
      statsPageUrl('data-experiment', 'rnaseqGene'),
      statsPageUrl('workflows', 'rnaseqGene'),
    ]);
  });

  test('edgr is undefined after four requests', async () => {
    const { deps, fetch } = makeDeps();
    expect(await findStatsPage(deps, 'edgr')).toBeUndefined();
    expect(fetch.calls).toHaveLength(4);
  });

  test('a 500 on the bioc page is upstream_error and stops', async () => {
    const { deps, fetch } = makeDeps({ [statsPageUrl('bioc', 'edgeR')]: { status: 500 } });
    expect(await codeOf(findStatsPage(deps, 'edgeR'))).toBe('upstream_error');
    expect(fetch.calls).toEqual([statsPageUrl('bioc', 'edgeR')]);
  });

  test('a name that cannot be a path segment is rejected before any request', async () => {
    const { deps, fetch } = makeDeps();
    expect(await codeOf(findStatsPage(deps, 'a/b'))).toBe('invalid_input');
    expect(fetch.calls).toEqual([]);
  });
});

describe('getStatsTab', () => {
  test('parses the file and keeps the response', async () => {
    const { deps } = makeDeps();
    const tab = await getStatsTab(deps, 'bioc', 'edgeR', 2026);
    expect(tab?.total.downloads).toBe(723176);
    expect(tab?.response.lastModified).toBe('2026-10-22T09:48:50.000Z');
  });

  test('404 is undefined', async () => {
    const { deps } = makeDeps({ [statsTabUrl('bioc', 'edgeR', 2027)]: NOT_FOUND });
    expect(await getStatsTab(deps, 'bioc', 'edgeR', 2027)).toBeUndefined();
  });

  test('500 is upstream_error', async () => {
    const { deps } = makeDeps({ [statsTabUrl('bioc', 'edgeR', 2027)]: { status: 500 } });
    expect(await codeOf(getStatsTab(deps, 'bioc', 'edgeR', 2027))).toBe('upstream_error');
  });
});

describe('getBiocConfig', () => {
  test('the fixture parses to strings, with release dates', async () => {
    const { config, response } = await getBiocConfig(makeDeps().deps);
    expect(config).toMatchObject({
      release_version: '3.23',
      devel_version: '3.24',
      r_version_associated_with_release: '4.6.0',
      r_version_associated_with_devel: '4.6.0',
    });
    expect(config.release_dates?.['3.23']).toBe('04/29/2026');
    expect(response.url).toBe(CONFIG_URL);
  });

  test('an unquoted version keeps its trailing zero', async () => {
    const body = 'release_version: 3.30\ndevel_version: 3.31\nr_version_associated_with_release: 4.10\nr_version_associated_with_devel: 4.10\n';
    const { config } = await getBiocConfig(makeDeps({ [CONFIG_URL]: { status: 200, body } }).deps);
    expect(config.release_version).toBe('3.30');
    expect(config.r_version_associated_with_release).toBe('4.10');
  });

  test.each([
    ['invalid YAML', 'release_version: [unclosed\n'],
    ['a missing key', 'devel_version: "3.24"\n'],
  ])('%s is upstream_error', async (_label, body) => {
    const { deps } = makeDeps({ [CONFIG_URL]: { status: 200, body } });
    expect(await codeOf(getBiocConfig(deps))).toBe('upstream_error');
  });
});

describe('getManifestIndex', () => {
  test('the fixture parses', async () => {
    const { index, response } = await getManifestIndex(makeDeps().deps);
    expect(index.versions).toEqual({ release: '3.23', devel: '3.24' });
    expect(index.manifests).toHaveLength(10);
    expect(response.url).toBe(MANIFEST_URL);
  });

  test('an array body is upstream_error', async () => {
    const { deps } = makeDeps({ [MANIFEST_URL]: { status: 200, body: '[]' } });
    expect(await codeOf(getManifestIndex(deps))).toBe('upstream_error');
  });
});

describe('biocDataRepoPath', () => {
  test.each([
    ['bioc', 'data/annotation', 'packages/devel/data/annotation/src/contrib/PACKAGES'],
    ['bioc', 'data/experiment', 'packages/devel/data/experiment/src/contrib/PACKAGES'],
    ['bioc-release', 'data/annotation', 'packages/release/data/annotation/src/contrib/PACKAGES'],
    ['bioc-release', 'data/experiment', 'packages/release/data/experiment/src/contrib/PACKAGES'],
  ] as const)('%s %s', (universe, repo, path) => {
    expect(biocDataRepoPath(universe, repo)).toBe(path);
  });
});

describe('getBiocDataPackagesFile', () => {
  test('reads the devel annotation list: GO.db', async () => {
    const { deps, fetch } = makeDeps(depsRoutes);
    const list = await getBiocDataPackagesFile(deps, 'bioc', 'data/annotation');
    expect([...list.versions.keys()]).toEqual(['GO.db']);
    expect(list.response.url).toBe(biocDataUrl('bioc', 'data/annotation'));
    expect(list.response.lastModified).toBe('2026-10-21T15:23:33.000Z');
    expect(fetch.calls).toEqual([biocDataUrl('bioc', 'data/annotation')]);
  });
});

describe('packagesPath', () => {
  test.each([
    ['bioc', 'packages/3.24/bioc/src/contrib/PACKAGES'],
    ['data-experiment', 'packages/3.24/data/experiment/src/contrib/PACKAGES'],
    ['workflows', 'packages/3.24/workflows/src/contrib/PACKAGES'],
    ['books', 'packages/3.24/books/src/contrib/PACKAGES'],
  ] as const)('%s', (repo, expected) => {
    expect(packagesPath('3.24', repo)).toBe(expected);
  });

  test.each(['3.24/../x', 'devel', '3', '3.24.1', '', '3.24 '])('version %j is an upstream_error', (version) => {
    expect(() => packagesPath(version, 'bioc')).toThrow(CapabilityError);
    try {
      packagesPath(version, 'bioc');
    } catch (error) {
      expect((error as CapabilityError).code).toBe('upstream_error');
    }
  });
});

describe('getBiocPackagesFile', () => {
  const experimentUrl = packagesUrl('3.24', 'data/experiment');

  test('returns the recorded entries with the last-modified and no body', async () => {
    const { deps, fetch } = makeDeps();
    const file = await getBiocPackagesFile(deps, '3.24', 'data-experiment');
    expect(fetch.calls).toEqual([experimentUrl]);
    expect([...file.versions]).toEqual([
      ...parsePackagesFile(
        readBiocFixture('packages/3.24/data/experiment/src/contrib/PACKAGES'),
        bioconductorUpstream,
        experimentUrl,
      ),
    ]);
    expect(file.versions.size).toBeGreaterThan(0);
    expect(file.response.lastModified).toBe('2026-10-22T21:31:29.000Z');
    expect('body' in file.response).toBe(false);
  });

  test('a 404 is an upstream_error naming the URL', async () => {
    const { deps } = makeDeps({ [packagesUrl('3.25', 'books')]: NOT_FOUND });
    const error = await getBiocPackagesFile(deps, '3.25', 'books').catch((e) => e);
    expect(error).toBeInstanceOf(CapabilityError);
    expect(error.code).toBe('upstream_error');
    expect(error.message).toBe(`bioconductor.org has no PACKAGES file at ${packagesUrl('3.25', 'books')}`);
    expect(error.details).toEqual({ upstream: 'bioconductor', url: packagesUrl('3.25', 'books') });
  });

  test('a bad version fetches nothing', async () => {
    const { deps, fetch } = makeDeps();
    expect(await codeOf(getBiocPackagesFile(deps, '3.24/../x', 'bioc'))).toBe('upstream_error');
    expect(await codeOf(getBiocPackagesFile(deps, 'devel', 'bioc'))).toBe('upstream_error');
    expect(fetch.calls).toEqual([]);
  });

  test('an empty 200 body is allowed', async () => {
    const { deps } = makeDeps({ [packagesUrl('3.25', 'books')]: { status: 200, body: '' } });
    expect((await getBiocPackagesFile(deps, '3.25', 'books')).versions.size).toBe(0);
  });
});
