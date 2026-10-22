import { describe, expect, test } from 'vitest';
import { invokeCapability } from '../../../src/core/invoke';
import { pkgDownloads, PkgDownloadsDataSchema, STATS_DEFINITION } from '../../../src/core/pkg/downloads';
import { envelopeBytes, MAX_RESULT_BYTES, type Envelope } from '../../../src/envelope';
import { createMemoryCache } from '../../../src/upstreams/cache';
import { bioconductorRoutes, readBiocFixture, statsPageUrl, statsTabUrl } from '../../support/bioconductor-routes';
import { fixtureFetch, type FixtureRoute } from '../../support/fixture-fetch';
import type * as z from 'zod';

type Data = z.output<typeof PkgDownloadsDataSchema>;

const OCT = '2026-10-22T12:00:00.000Z';
const JAN = '2027-01-05T12:00:00.000Z';
const AS_OF = '2026-10-22';

const EDGER_PAGE = readBiocFixture('packages/stats/bioc/edgeR/index.html');

function setup(at: string, extra: Record<string, FixtureRoute> = {}) {
  const fetch = fixtureFetch({ ...bioconductorRoutes, ...extra });
  const now = () => new Date(at);
  return { fetch, deps: { fetch, cache: createMemoryCache(now), now, env: {} } };
}

async function run(input: { package: string; year?: number }, at = OCT, extra: Record<string, FixtureRoute> = {}) {
  const { fetch, deps } = setup(at, extra);
  return { result: await invokeCapability(pkgDownloads, input, deps), fetch };
}

async function downloads(input: { package: string; year?: number }, at = OCT, extra: Record<string, FixtureRoute> = {}) {
  const { result, fetch } = await run(input, at, extra);
  if (!result.ok) throw result.error;
  const envelope = result.envelope as Envelope<Data>;
  return { envelope, data: envelope.data, fetch };
}

describe('pkg_downloads', () => {
  test('default year: edgeR in October 2026', async () => {
    const { envelope, data, fetch } = await downloads({ package: 'edgeR' });
    expect(data).toMatchObject({
      package: 'edgeR',
      category: 'bioc',
      year: 2026,
      year_requested: null,
      data_as_of: AS_OF,
      partial_month: 'Oct',
      total: { distinct_ips: 235261, downloads: 723176 },
      note: null,
      definition: STATS_DEFINITION,
      stats_page_url: statsPageUrl('bioc', 'edgeR'),
    });
    expect(data.months).toHaveLength(10);
    expect(data.months[0]).toEqual({ month: 'Jan', distinct_ips: 28941, downloads: 53538 });
    expect(data.months.at(-1)).toEqual({ month: 'Oct', distinct_ips: 31249, downloads: 76192 });
    expect(data.years_available).toHaveLength(18);
    expect(data.years_available[0]).toBe(2009);
    expect(data.years_available.at(-1)).toBe(2026);
    expect(envelope.sources).toEqual([
      { url: statsPageUrl('bioc', 'edgeR'), as_of: AS_OF },
      { url: statsTabUrl('bioc', 'edgeR', 2026), as_of: AS_OF },
    ]);
    expect(envelope.summary).toBe(
      'edgeR (bioc) in 2026: 723176 downloads from 235261 distinct IPs through 2026-10-22. ' +
        "Figures follow bioconductor.org's published /packages/stats definition.",
    );
    expect(fetch.calls).toEqual([statsPageUrl('bioc', 'edgeR'), statsTabUrl('bioc', 'edgeR', 2026)]);
    expect(envelopeBytes(envelope)).toBeLessThan(MAX_RESULT_BYTES);
  });

  test('explicit past year: edgeR 2025 is complete', async () => {
    const { envelope, data, fetch } = await downloads({ package: 'edgeR', year: 2025 });
    expect(data).toMatchObject({
      category: 'bioc',
      year: 2025,
      year_requested: 2025,
      partial_month: null,
      total: { distinct_ips: 226167, downloads: 841103 },
      note: null,
    });
    expect(data.months).toHaveLength(12);
    expect(data.months[0]).toMatchObject({ month: 'Jan', downloads: 34147 });
    expect(data.months.at(-1)).toMatchObject({ month: 'Dec', downloads: 66159 });
    expect(envelope.summary).toBe(
      'edgeR (bioc) in 2025: 841103 downloads from 226167 distinct IPs. ' +
        "Figures follow bioconductor.org's published /packages/stats definition.",
    );
    expect(fetch.calls).toEqual([statsPageUrl('bioc', 'edgeR'), statsTabUrl('bioc', 'edgeR', 2025)]);
  });

  test('other category: rnaseqGene is a workflow, after three 404 pages', async () => {
    const { envelope, data, fetch } = await downloads({ package: 'rnaseqGene' });
    expect(data).toMatchObject({ category: 'workflows', year: 2026, partial_month: 'Oct', total: { downloads: 4730 } });
    expect(data.months).toHaveLength(10);
    expect(fetch.calls).toEqual([
      statsPageUrl('bioc', 'rnaseqGene'),
      statsPageUrl('data-annotation', 'rnaseqGene'),
      statsPageUrl('data-experiment', 'rnaseqGene'),
      statsPageUrl('workflows', 'rnaseqGene'),
      statsTabUrl('workflows', 'rnaseqGene', 2026),
    ]);
    // The 404 category pages supplied no data and are not listed.
    expect(envelope.sources.map((s) => s.url)).toEqual([
      statsPageUrl('workflows', 'rnaseqGene'),
      statsTabUrl('workflows', 'rnaseqGene', 2026),
    ]);
  });

  test('unknown package: not_found after four page requests and no .tab request', async () => {
    const { result, fetch } = await run({ package: 'edgr' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not_found');
    expect(result.error.message).toContain('bioc, data-annotation, data-experiment, workflows');
    expect(result.error.message).toContain('case-sensitive');
    expect(fetch.calls).toEqual(['bioc', 'data-annotation', 'data-experiment', 'workflows'].map((c) => statsPageUrl(c as 'bioc', 'edgr')));
  });

  test('a year without stats: not_found without fetching a .tab', async () => {
    const { result, fetch } = await run({ package: 'edgeR', year: 2027 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not_found');
    expect(result.error.message).toBe('edgeR (bioc) has no download stats for 2027; years with stats: 2009–2026.');
    expect(fetch.calls).toEqual([statsPageUrl('bioc', 'edgeR')]);
  });

  test('January: the default year falls back to the latest year with stats', async () => {
    const { envelope, data, fetch } = await downloads({ package: 'edgeR' }, JAN);
    const note = 'bioconductor.org has no 2027 download stats for edgeR yet; showing 2026, the latest year with stats.';
    expect(data).toMatchObject({ year: 2026, year_requested: null, note, data_as_of: AS_OF, partial_month: 'Oct' });
    expect(data.months).toHaveLength(10);
    expect(envelope.summary).toContain(` through ${AS_OF}. ${note} Figures follow`);
    expect(fetch.calls.some((url) => url.includes('_2027_'))).toBe(false);
    expect(fetch.calls).toEqual([statsPageUrl('bioc', 'edgeR'), statsTabUrl('bioc', 'edgeR', 2026)]);
  });

  test('a page without "Data as of": all 12 months, and sources fall back to Last-Modified', async () => {
    const page = EDGER_PAGE.replace(/Data as of/g, 'Computed');
    const { envelope, data } = await downloads({ package: 'edgeR' }, OCT, {
      [statsPageUrl('bioc', 'edgeR')]: { status: 200, body: page },
    });
    expect(data.data_as_of).toBeNull();
    expect(data.months).toHaveLength(12);
    expect(data.partial_month).toBeNull();
    expect(envelope.sources).toEqual([
      { url: statsPageUrl('bioc', 'edgeR'), as_of: OCT },
      { url: statsTabUrl('bioc', 'edgeR', 2026), as_of: '2026-10-22T09:48:50.000Z' },
    ]);
    expect(envelope.summary).not.toContain('through');
  });

  test('a page that lists a year whose .tab is 404 is upstream_error', async () => {
    const { result } = await run({ package: 'edgeR', year: 2024 }, OCT, {
      [statsTabUrl('bioc', 'edgeR', 2024)]: { status: 404, body: 'Not Found' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('upstream_error');
    expect(result.error.details.url).toBe(statsTabUrl('bioc', 'edgeR', 2024));
  });

  test('a page that links no years is not_found', async () => {
    const { result } = await run({ package: 'edgeR' }, OCT, {
      [statsPageUrl('bioc', 'edgeR')]: { status: 200, body: '<html>Data as of 22 Oct 2026</html>' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not_found');
      expect(result.error.message).toBe('edgeR (bioc) has no yearly download stats on bioconductor.org.');
    }
  });

  test('a second identical call within the TTL makes no new requests', async () => {
    const { fetch, deps } = setup(OCT);
    await invokeCapability(pkgDownloads, { package: 'edgeR' }, deps);
    const calls = fetch.calls.length;
    const second = await invokeCapability(pkgDownloads, { package: 'edgeR' }, deps);
    expect(second.ok).toBe(true);
    expect(fetch.calls).toHaveLength(calls);
  });

  test.each([
    { package: "a'b" },
    { package: 'x' },
    { package: 'edgeR', year: 2008 },
    { package: 'edgeR', year: 2101 },
    { package: 'edgeR', year: 2025.5 },
    { package: 'edgeR', year: Number.NaN },
  ])('invalid input %j fetches nothing', async (input) => {
    const { result, fetch } = await run(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_input');
    expect(fetch.calls).toEqual([]);
  });
});
