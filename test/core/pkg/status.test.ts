import { describe, expect, test } from 'vitest';
import { invokeCapability } from '../../../src/core/invoke';
import { compareRVersions, historySql, pkgStatus, PkgStatusDataSchema } from '../../../src/core/pkg/status';
import { envelopeBytes, MAX_RESULT_BYTES, type Envelope } from '../../../src/envelope';
import { createMemoryCache } from '../../../src/upstreams/cache';
import { createMemoryUsageSink } from '../../../src/usage';
import { fixtureFetch } from '../../support/fixture-fetch';
import { BIOC_INDEX_URL, pkgRoutes, RELEASE_INDEX_URL, ruUrl } from '../../support/pkg-routes';
import type * as z from 'zod';

type Data = z.output<typeof PkgStatusDataSchema>;

const NOW = '2026-10-22T12:00:00.000Z';

function run(input: { package: string; universe?: 'bioc' | 'bioc-release' }) {
  const fetch = fixtureFetch(pkgRoutes);
  const now = () => new Date(NOW);
  const usage = createMemoryUsageSink();
  return invokeCapability(
    pkgStatus,
    input,
    { fetch, cache: createMemoryCache(now), now, env: {} },
    { transport: 'rest', usage },
  ).then((result) => ({ result, fetch, usage }));
}

async function status(input: { package: string; universe?: 'bioc' | 'bioc-release' }) {
  const { result, fetch } = await run(input);
  if (!result.ok) throw result.error;
  return { envelope: result.envelope as Envelope<Data>, data: (result.envelope as Envelope<Data>).data, fetch };
}

describe('compareRVersions', () => {
  test.each([
    ['1.49.3', '1.49.3', 0],
    ['1.3.4', '1.3.3', 1],
    ['1.10.0', '1.9.9', 1],
    ['1.2', '1.2.0', -1],
    ['1.2-3', '1.2.2', 1],
    ['abc', '1.2.3', null],
    ['1.2.3', 'abc', null],
  ] as const)('%s vs %s is %s', (a, b, expected) => {
    expect(compareRVersions(a, b)).toBe(expected);
  });
});

describe('historySql', () => {
  test('is the exact query', () => {
    expect(historySql('bioc', 'edgeR')).toBe(
      [
        'SELECT obs_ts, config, r, "check", time, job',
        'FROM jobs',
        "WHERE universe = 'bioc' AND package = 'edgeR'",
        'ORDER BY obs_ts DESC, config',
        'LIMIT 200',
      ].join('\n'),
    );
  });
});

describe('pkg_status', () => {
  test('records one usage event with upstream_status 200 and no input values', async () => {
    const { result, usage } = await run({ package: 'trackViewer' });
    expect(result.ok).toBe(true);
    expect(usage.events).toHaveLength(1);
    expect(usage.events[0]).toMatchObject({ capability: 'pkg_status', upstream_status: 200, ok: true, error_code: null });
    expect(JSON.stringify(usage.events)).not.toContain('trackViewer');
  });

  test('propagated and passing: trackViewer', async () => {
    const { envelope, data } = await status({ package: 'trackViewer' });
    expect(data.universe).toBe('bioc');
    expect(data.propagated).toMatchObject({
      version: '1.49.3',
      origin: 'r-universe',
      passed_gate: true,
    });
    expect(data.upstream).toMatchObject({ version: '1.49.3', status: 'success', newer_commit_failed: null });
    expect(data.upstream?.jobs).toHaveLength(10);
    for (const job of data.upstream?.jobs ?? []) {
      expect(job.url).toBe(`${data.upstream?.build_url}/job/${job.job}`);
    }
    expect(data.upstream?.jobs.filter((j) => j.check !== 'OK').map((j) => [j.config, j.check])).toEqual([
      ['bioc-checks', 'WARNING'],
    ]);
    expect(data.behind).toBe(false);
    expect(data.behind_reasons).toEqual([]);
    expect(data.history_sql.query).toBe(historySql('bioc', 'trackViewer'));
    expect(data.history_sql.console_url).toBe('https://bioc-registry.seandavi.workers.dev/sql');
    expect(envelope.sources).toEqual([
      { url: BIOC_INDEX_URL, as_of: NOW },
      { url: ruUrl('bioc', 'trackViewer'), as_of: '2026-10-22T12:19:43.000Z' },
    ]);
    expect(envelope.summary).toContain('trackViewer (bioc) is propagated at 1.49.3 (passed the gate via r-universe');
    expect(envelope.summary).toContain('r-universe builds 1.49.3: status success.');
    expect(envelope.summary).not.toContain('newer');
  });

  test('upstream newer and failing: Chromatograms', async () => {
    const { envelope, data } = await status({ package: 'Chromatograms' });
    expect(data.propagated?.version).toBe('1.3.3');
    expect(data.upstream).toMatchObject({ version: '1.3.4', status: 'failure' });
    expect(data.behind).toBe(true);
    expect(data.behind_reasons).toEqual([
      `r-universe's build of 1.3.4 has status "failure".`,
      'R CMD check fails on source (ERROR).',
    ]);
    expect(envelope.summary).toContain('failing source (ERROR)');
    expect(envelope.summary).toContain('Upstream 1.3.4 is newer than propagated 1.3.3.');
    // r-universe has no Last-Modified in the fixture, so as_of is the test clock
    expect(envelope.sources[1]).toEqual({ url: ruUrl('bioc', 'Chromatograms'), as_of: NOW });
  });

  test('newer commit failed, not behind: RMassBank', async () => {
    const { envelope, data } = await status({ package: 'RMassBank' });
    expect(data.propagated).toMatchObject({ version: '3.23.0', origin: 'r-universe', passed_gate: true, archs: null });
    expect(data.upstream).toMatchObject({ version: '3.23.0', status: 'success' });
    expect(data.upstream?.newer_commit_failed).toMatchObject({ version: '3.23.1' });
    expect(data.upstream?.newer_commit_failed?.job).toMatchObject({ config: 'source', check: 'ERROR' });
    expect(data.upstream?.newer_commit_failed?.job?.url).toBe(
      `${data.upstream?.newer_commit_failed?.build_url}/job/${data.upstream?.newer_commit_failed?.job?.job}`,
    );
    expect(data.behind).toBe(false);
    expect(data.behind_reasons).toEqual([]);
    expect(envelope.summary).toContain('A newer commit (3.23.1) failed on source (ERROR).');
  });

  test('seeded only, upstream failing: biomaRt', async () => {
    const { envelope, data } = await status({ package: 'biomaRt' });
    expect(data.propagated).toMatchObject({
      version: '2.69.0',
      origin: 'bioconductor',
      passed_gate: false,
      bioccheck: null,
    });
    expect(data.propagated?.source_commit?.id).toHaveLength(7);
    expect(data.upstream).toMatchObject({ version: '2.69.5', status: 'failure' });
    expect(data.behind).toBe(true);
    expect(data.behind_reasons[0]).toContain('seeded from Bioconductor');
    expect(data.behind_reasons[1]).toBe(`r-universe's build of 2.69.5 has status "failure".`);
    expect(data.behind_reasons[2]).toMatch(/^R CMD check fails on /);
    expect(envelope.summary).toContain('seeded from Bioconductor, never gated');
  });

  test('seeded, upstream success but checks failing: ClustIRR caps the config list at five', async () => {
    const { data } = await status({ package: 'ClustIRR' });
    expect(data.propagated?.origin).toBe('bioconductor');
    expect(data.upstream?.status).toBe('success');
    expect(data.behind).toBe(true);
    expect(data.behind_reasons).toHaveLength(2);
    expect(data.behind_reasons[0]).toContain('seeded from Bioconductor');
    expect(data.behind_reasons[1]).toMatch(/^R CMD check fails on (\S+ \(ERROR\), ){4}\S+ \(ERROR\) and 8 more\.$/);
  });

  test('never propagated: BiocSet', async () => {
    const { envelope, data } = await status({ package: 'BiocSet' });
    expect(data.propagated).toBeNull();
    expect(data.upstream).toMatchObject({ version: '1.27.0', status: 'failure' });
    expect(data.behind).toBeNull();
    expect(data.behind_reasons[0]).toBe('No entry in the bioc propagation index.');
    expect(data.behind_reasons[1]).toContain('has status "failure"');
    expect(envelope.summary).toContain('BiocSet is not in the bioc propagation index.');
  });

  test('propagated, no upstream record: Fletcher2013a', async () => {
    const { envelope, data } = await status({ package: 'Fletcher2013a' });
    expect(data.propagated).toMatchObject({ version: '1.49.0', origin: 'bioc-build', passed_gate: true });
    expect(data.upstream).toBeNull();
    expect(data.behind).toBeNull();
    expect(data.behind_reasons).toEqual([]);
    expect(envelope.summary).toContain('r-universe has no current build of Fletcher2013a in bioc.');
    expect(envelope.sources[1]).toEqual({ url: ruUrl('bioc', 'Fletcher2013a'), as_of: NOW });
  });

  test('largest result: SEMPLR fits under the 8 KB limit', async () => {
    const { envelope, data } = await status({ package: 'SEMPLR' });
    expect(data.propagated?.artifacts).toHaveLength(27);
    expect(data.upstream?.jobs).toHaveLength(16);
    expect(envelopeBytes(envelope)).toBeLessThan(MAX_RESULT_BYTES);
  });

  test('release universe: edgeR fetches only the bioc-release URLs', async () => {
    const { envelope, data, fetch } = await status({ package: 'edgeR', universe: 'bioc-release' });
    expect(data.universe).toBe('bioc-release');
    expect(data.propagated?.version).toBe('4.10.7');
    expect(data.upstream).toMatchObject({ version: '4.10.7', status: 'success' });
    expect(data.behind).toBe(false);
    expect(data.history_sql.query).toContain("universe = 'bioc-release'");
    expect([...fetch.calls].sort()).toEqual([RELEASE_INDEX_URL, ruUrl('bioc-release', 'edgeR')].sort());
    expect(envelope.sources[0]?.url).toBe(RELEASE_INDEX_URL);
  });

  test.each([
    ['edgr', 'Did you mean: edge, edgeR?'],
    ['biomart', 'Did you mean: biomaRt?'],
  ])('unknown package %s is not_found with suggestions', async (name, hint) => {
    const { result, fetch } = await run({ package: name });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not_found');
    expect(result.error.message).toContain(hint);
    expect(fetch.calls).toContain(BIOC_INDEX_URL);
    expect(fetch.calls).toContain(ruUrl('bioc', name));
  });

  test.each(["a'b", '1abc', 'x', 'edgeR.'])('invalid name %j is invalid_input and fetches nothing', async (name) => {
    const { result, fetch } = await run({ package: name });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_input');
    expect(fetch.calls).toEqual([]);
  });

  test('an r-universe outage fails the whole call', async () => {
    const fetch = fixtureFetch({ ...pkgRoutes, [ruUrl('bioc', 'trackViewer')]: { status: 500 } });
    const now = () => new Date(NOW);
    const result = await invokeCapability(
      pkgStatus,
      { package: 'trackViewer' },
      { fetch, cache: createMemoryCache(now), now, env: {} },
      { transport: 'rest', usage: createMemoryUsageSink() },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('upstream_error');
  });
});
