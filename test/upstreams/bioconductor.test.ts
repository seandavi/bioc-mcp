import { describe, expect, test } from 'vitest';
import type { Deps } from '../../src/core/deps';
import { CapabilityError } from '../../src/errors';
import { createMemoryCache } from '../../src/upstreams/cache';
import {
  biocDataRepoPath,
  findStatsPage,
  getBiocDataPackageList,
  getBiocConfig,
  getManifestIndex,
  getPackagesFile,
  getStatsTab,
  packagesPath,
  parseDataAsOf,
  parsePackagesFile,
  parseStatsTab,
  parseStatsYears,
} from '../../src/upstreams/bioconductor';
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

describe('getBiocDataPackageList', () => {
  test('reads the devel annotation list: GO.db', async () => {
    const { deps, fetch } = makeDeps(depsRoutes);
    const list = await getBiocDataPackageList(deps, 'bioc', 'data/annotation');
    expect([...list.names]).toEqual(['GO.db']);
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

describe('parsePackagesFile', () => {
  const URL = packagesUrl('3.24', 'bioc');
  const stanza = (name: string, version: string) => `Package: ${name}\nVersion: ${version}\nDepends: R (>= 4.0)\n`;

  test('the recorded 3.24 software file gives its ten packages in file order', () => {
    const versions = parsePackagesFile(readBiocFixture('packages/3.24/bioc/src/contrib/PACKAGES'), URL);
    expect([...versions]).toEqual([
      ['anndataR', '1.3.2'],
      ['biomaRt', '2.69.3'],
      ['Chromatograms', '1.3.4'],
      ['ClustIRR', '1.11.0'],
      ['edge', '2.45.0'],
      ['edgeR', '4.99.10'],
      ['lipidr', '2.27.0'],
      ['RMassBank', '3.23.0'],
      ['SEMPLR', '1.1.2'],
      ['trackViewer', '1.49.3'],
    ]);
  });

  test('continuation lines are ignored', () => {
    const body = 'Package: abc\nVersion: 1.0\nImports: foo,\n    bar,\n\tbaz\nDescription: x\n  Version: 9.9\n';
    expect([...parsePackagesFile(body, URL)]).toEqual([['abc', '1.0']]);
  });

  test('CRLF bodies parse the same', () => {
    const body = stanza('abc', '1.0') + '\n' + stanza('def', '2.0-1');
    expect(parsePackagesFile(body.replaceAll('\n', '\r\n'), URL)).toEqual(parsePackagesFile(body, URL));
  });

  test('consecutive blank lines are allowed; empty and blank bodies give an empty Map', () => {
    expect([...parsePackagesFile(stanza('abc', '1.0') + '\n\n \n' + stanza('def', '2.0'), URL).keys()]).toEqual([
      'abc',
      'def',
    ]);
    expect(parsePackagesFile('', URL).size).toBe(0);
    expect(parsePackagesFile('\n\n  \n', URL).size).toBe(0);
  });

  test.each([
    ['a stanza without Version', 'Package: abc\nDepends: R\n'],
    ['a stanza without Package', 'Version: 1.0\n'],
    ['two Package lines in one stanza', 'Package: abc\nPackage: def\nVersion: 1.0\n'],
    ['two Version lines in one stanza', 'Package: abc\nVersion: 1.0\nVersion: 1.1\n'],
    ['the same package in two stanzas', stanza('abc', '1.0') + '\n' + stanza('abc', '1.1')],
    ['a version 1.0.0a', stanza('abc', '1.0.0a')],
    ['an empty version', 'Package: abc\nVersion:\n'],
    ['an invalid package name', stanza('1abc', '1.0')],
    ['a package name ending in a dot', stanza('abc.', '1.0')],
    ['a continuation line before any field', '  continued\nPackage: abc\nVersion: 1.0\n'],
    ['a continuation line after a blank line', stanza('abc', '1.0') + '\n  continued\n'],
    ['a line with no colon', 'Package: abc\nVersion 1.0\n'],
  ])('%s throws upstream_error naming the URL', (_label, body) => {
    let error: unknown;
    try {
      parsePackagesFile(body, URL);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CapabilityError);
    expect((error as CapabilityError).code).toBe('upstream_error');
    expect((error as CapabilityError).message).toContain(URL);
    expect((error as CapabilityError).details).toEqual({ upstream: 'bioconductor', url: URL });
  });
});

describe('getPackagesFile', () => {
  test('returns the recorded body with its last-modified', async () => {
    const { deps, fetch } = makeDeps();
    const response = await getPackagesFile(deps, '3.24', 'data-experiment');
    expect(fetch.calls).toEqual([packagesUrl('3.24', 'data/experiment')]);
    expect(response.body).toBe(readBiocFixture('packages/3.24/data/experiment/src/contrib/PACKAGES'));
    expect(response.lastModified).toBe('2026-10-22T21:31:29.000Z');
  });

  test('a 404 is an upstream_error naming the repository path and version', async () => {
    const { deps } = makeDeps({ [packagesUrl('3.25', 'books')]: NOT_FOUND });
    const error = await getPackagesFile(deps, '3.25', 'books').catch((e) => e);
    expect(error).toBeInstanceOf(CapabilityError);
    expect(error.code).toBe('upstream_error');
    expect(error.message).toContain('books PACKAGES for Bioconductor 3.25');
    expect(error.message).toContain(packagesUrl('3.25', 'books'));
  });

  test('a bad version fetches nothing', async () => {
    const { deps, fetch } = makeDeps();
    expect(await codeOf(getPackagesFile(deps, '3.24/../x', 'bioc'))).toBe('upstream_error');
    expect(await codeOf(getPackagesFile(deps, 'devel', 'bioc'))).toBe('upstream_error');
    expect(fetch.calls).toEqual([]);
  });
});
