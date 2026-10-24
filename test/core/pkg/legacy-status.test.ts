import { describe, expect, test } from 'vitest';
import type * as z from 'zod';
import type { Deps, FetchFn } from '../../../src/core/deps';
import { invokeCapability } from '../../../src/core/invoke';
import {
  BIOCBUILDDB_BUILD_SUMMARY_URL,
  familyVerdict,
  legacyHistorySql,
  nodeVerdict,
  osFamily,
  pkgLegacyStatus,
  PkgLegacyStatusDataSchema,
} from '../../../src/core/pkg/legacy-status';
import { envelopeBytes, MAX_RESULT_BYTES, type Envelope } from '../../../src/envelope';
import { createMemoryCache } from '../../../src/upstreams/cache';
import { createMemoryUsageSink } from '../../../src/usage';
import { bbsRoutes, bbsUrl, liveIndexRoutes } from '../../support/bbs-routes';
import { NOT_FOUND } from '../../support/bioconductor-routes';
import { fixtureFetch, type FixtureRoute } from '../../support/fixture-fetch';
import { BIOC_INDEX_URL, pkgRoutes, RELEASE_INDEX_URL } from '../../support/pkg-routes';

type Data = z.output<typeof PkgLegacyStatusDataSchema>;
type Input = { package: string; universe?: 'bioc' | 'bioc-release' };

const NOW = '2026-10-24T12:00:00.000Z';
const ROUTES = { ...pkgRoutes, ...bbsRoutes };

const iso = (url: string) => {
  const route = bbsRoutes[url] as { headers: Record<string, string> };
  return new Date(route.headers['last-modified']!).toISOString();
};

const DEVEL_STATUS = bbsUrl('devel', 'bioc', 'BUILD_STATUS_DB.txt');
const DEVEL_PROPAGATION = bbsUrl('devel', 'bioc', 'PROPAGATION_STATUS_DB.txt');
const DEVEL_STATUS_URLS = (['bioc', 'data-experiment', 'workflows', 'books'] as const).map((build) =>
  bbsUrl('devel', build, 'BUILD_STATUS_DB.txt'),
);
const infoUrl = (name: string) => bbsUrl('devel', 'bioc', `${name}/raw-results/info.dcf`);
const nodeUrl = (node: string) => bbsUrl('devel', 'bioc', `${node}-NodeInfo.html`);
const bbsSource = (url: string) => ({ url, as_of: iso(url) });

function setup(routes: Record<string, FixtureRoute> = ROUTES, clock = { ms: Date.parse(NOW) }) {
  const fetch = fixtureFetch(routes);
  const now = () => new Date(clock.ms);
  const deps: Deps = { fetch, cache: createMemoryCache(now), now, env: {} };
  return { fetch, deps, clock };
}

function invoke(input: Input, deps: Deps) {
  const usage = createMemoryUsageSink();
  return invokeCapability(pkgLegacyStatus, input, deps, { transport: 'rest', usage }).then((result) => ({
    result,
    usage,
  }));
}

async function legacy(input: Input, extraRoutes: Record<string, FixtureRoute> = {}) {
  const { fetch, deps } = setup({ ...ROUTES, ...extraRoutes });
  const { result } = await invoke(input, deps);
  if (!result.ok) throw result.error;
  const envelope = result.envelope as Envelope<Data>;
  expect(envelopeBytes(envelope)).toBeLessThan(MAX_RESULT_BYTES);
  return { envelope, data: envelope.data, summary: envelope.summary, fetch };
}

async function failure(input: Input, extraRoutes: Record<string, FixtureRoute> = {}) {
  const { fetch, deps } = setup({ ...ROUTES, ...extraRoutes });
  const { result } = await invoke(input, deps);
  if (result.ok) throw new Error('expected an error');
  return { error: result.error, fetch };
}

const sorted = (calls: string[]) => [...calls].sort();
const stageTable = (node: NonNullable<Data['legacy']>['nodes'][number]) =>
  node.stages.map((s) => `${s.stage} ${s.status}`);

describe('osFamily', () => {
  test.each([
    ['Linux (Ubuntu 24.04.4 LTS)', 'linux'],
    ['macOS 12.7.6 Monterey', 'mac'],
    ['Mac OS X 10.13', 'mac'],
    ['Windows Server 2022 Datacenter', 'win'],
    ['FreeBSD', null],
    [null, null],
  ] as const)('%s → %s', (os, expected) => {
    expect(osFamily(os)).toBe(expected);
  });
});

describe('nodeVerdict', () => {
  const stages = (...statuses: string[]) => statuses.map((status) => ({ status }));
  test.each([
    [['OK', 'WARNINGS'], 'ok'],
    [['OK', 'ERROR', 'skipped'], 'failed'],
    [['OK', 'TIMEOUT'], 'failed'],
    [['OK', 'NA'], 'incomplete'],
    [['OK', 'skipped'], 'incomplete'],
  ] as const)('%j → %s', (statuses, expected) => {
    expect(nodeVerdict(stages(...statuses))).toBe(expected);
  });
});

describe('familyVerdict', () => {
  test.each([
    [[], null],
    [['ok', 'incomplete'], 'incomplete'],
    [['incomplete', 'failed'], 'failed'],
    [['ok', 'ok'], 'ok'],
  ] as const)('%j → %s', (verdicts, expected) => {
    expect(familyVerdict(verdicts)).toBe(expected);
  });
});

describe('legacyHistorySql', () => {
  test('is the exact query', () => {
    expect(legacyHistorySql('edgeR')).toBe(
      [
        'SELECT startedat, node, stage, version, status',
        "FROM 'https://bioc-builddb-mirror.s3.amazonaws.com/parquet/build_summary.parquet'",
        "WHERE package = 'edgeR'",
        'ORDER BY startedat DESC, node, stage',
        'LIMIT 200',
      ].join('\n'),
    );
  });

  test('rejects a name that is not a package name', () => {
    expect(() => legacyHistorySql("a'b")).toThrow();
  });
});

describe('pkg_legacy_status scenarios', () => {
  test('records one usage event with upstream_status 200 and no input values', async () => {
    const { deps } = setup();
    const { result, usage } = await invoke({ package: 'trackViewer' }, deps);
    expect(result.ok).toBe(true);
    expect(usage.events).toHaveLength(1);
    expect(usage.events[0]).toMatchObject({
      capability: 'pkg_legacy_status',
      upstream_status: 200,
      ok: true,
      error_code: null,
    });
    expect(JSON.stringify(usage.events)).not.toContain('trackViewer');
  });

  test('all ok, agrees: trackViewer', async () => {
    const { envelope, data, summary, fetch } = await legacy({ package: 'trackViewer' });
    expect(data.universe).toBe('bioc');
    expect(data.legacy).toMatchObject({
      report: 'devel',
      build: 'bioc',
      version: '1.49.3',
      commit: { id: '602809b', time: '2026-09-29T15:32:11-04:00', branch: 'devel' },
      report_url: 'https://bioconductor.org/checkResults/devel/bioc-LATEST/trackViewer/',
      as_of: iso(DEVEL_STATUS),
    });
    expect(data.legacy?.nodes.map((n) => [n.node, n.os, n.arch, n.family, n.verdict])).toEqual([
      ['nebbiolo2', 'Linux (Ubuntu 24.04.4 LTS)', 'x86_64', 'linux', 'ok'],
      ['lconway', 'macOS 12.7.6 Monterey', 'x86_64', 'mac', 'ok'],
      ['taishan', 'Linux (openEuler 24.03 LTS)', 'aarch64', 'linux', 'ok'],
    ]);
    for (const node of data.legacy!.nodes) for (const stage of node.stages) expect(stage.url).toBeNull();
    expect(stageTable(data.legacy!.nodes[1]!)).toEqual([
      'install OK',
      'buildsrc OK',
      'checksrc OK',
      'buildbin OK',
    ]);
    expect(data.legacy?.propagation).toEqual([
      { target: 'source', status: 'UNNEEDED', reason: 'same version is already published' },
      { target: 'mac.binary.big-sur-x86_64', status: 'UNNEEDED', reason: 'same version is already published' },
    ]);
    expect(data.registry).toEqual({
      version: '1.49.3',
      origin: 'r-universe',
      passed_gate: true,
      archs: ['linux', 'win', 'mac'],
      propagated_at: expect.any(String),
    });
    expect(data.comparison).toEqual([
      { family: 'linux', bbs_nodes: ['nebbiolo2', 'taishan'], bbs_verdict: 'ok', registry_passed: true },
      { family: 'mac', bbs_nodes: ['lconway'], bbs_verdict: 'ok', registry_passed: true },
      { family: 'win', bbs_nodes: [], bbs_verdict: null, registry_passed: true },
    ]);
    expect(data.same_version).toBe(true);
    expect(data.history_sql).toEqual({
      query: legacyHistorySql('trackViewer'),
      parquet_url: BIOCBUILDDB_BUILD_SUMMARY_URL,
    });
    expect(summary).toBe(
      "trackViewer 1.49.3 in the legacy build system's devel bioc report (2026-10-23): nebbiolo2 (linux) ok; " +
        'lconway (mac) ok; taishan (linux) ok. BBS propagation: source UNNEEDED (same version is already published); ' +
        'mac.binary.big-sur-x86_64 UNNEEDED (same version is already published). ' +
        'The registry propagated 1.49.3 (passed the gate via r-universe; families linux, win, mac).',
    );
    expect(envelope.sources).toEqual([
      bbsSource(DEVEL_STATUS),
      bbsSource(DEVEL_PROPAGATION),
      bbsSource(infoUrl('trackViewer')),
      bbsSource(nodeUrl('nebbiolo2')),
      bbsSource(nodeUrl('lconway')),
      bbsSource(nodeUrl('taishan')),
      { url: BIOC_INDEX_URL, as_of: NOW },
    ]);
    expect(sorted(fetch.calls)).toEqual(
      sorted([
        BIOC_INDEX_URL,
        DEVEL_STATUS,
        DEVEL_PROPAGATION,
        infoUrl('trackViewer'),
        nodeUrl('nebbiolo2'),
        nodeUrl('lconway'),
        nodeUrl('taishan'),
      ]),
    );
  });

  test('BBS fails, registry passed linux: GEOfastq', async () => {
    const { data, summary } = await legacy({ package: 'GEOfastq' });
    const taishan = data.legacy!.nodes.find((n) => n.node === 'taishan')!;
    expect(taishan.verdict).toBe('failed');
    expect(taishan.stages.find((s) => s.stage === 'checksrc')).toMatchObject({ status: 'ERROR' });
    expect(taishan.stages.find((s) => s.stage === 'checksrc')!.url).toBe(
      'https://bioconductor.org/checkResults/devel/bioc-LATEST/GEOfastq/taishan-checksrc.html',
    );
    expect(taishan.stages.filter((s) => s.status === 'OK').every((s) => s.url === null)).toBe(true);
    expect(data.legacy!.nodes.filter((n) => n.verdict === 'ok').map((n) => n.node)).toEqual(['nebbiolo2', 'lconway']);
    expect(data.registry).toMatchObject({ version: '1.21.0', origin: 'r-universe', archs: ['linux', 'mac'] });
    expect(data.comparison).toEqual([
      { family: 'linux', bbs_nodes: ['nebbiolo2', 'taishan'], bbs_verdict: 'failed', registry_passed: true },
      { family: 'mac', bbs_nodes: ['lconway'], bbs_verdict: 'ok', registry_passed: true },
    ]);
    expect(summary).toBe(
      "GEOfastq 1.21.0 in the legacy build system's devel bioc report (2026-10-23): nebbiolo2 (linux) ok; " +
        'lconway (mac) ok; taishan (linux) failed (checksrc ERROR). BBS propagation: source UNNEEDED (same version ' +
        'is already published); mac.binary.big-sur-x86_64 UNNEEDED (same version is already published). ' +
        'The registry propagated 1.21.0 (passed the gate via r-universe; families linux, mac). ' +
        'BBS and the registry disagree on linux (BBS failed, registry passed).',
    );
  });

  test('failed everywhere, seeded: biomaRt', async () => {
    const { data, summary } = await legacy({ package: 'biomaRt' });
    const nodes = Object.fromEntries(data.legacy!.nodes.map((n) => [n.node, n]));
    expect(nodes.nebbiolo2).toMatchObject({ verdict: 'failed' });
    expect(nodes.taishan).toMatchObject({ verdict: 'failed' });
    expect(nodes.lconway).toMatchObject({ verdict: 'failed' });
    expect(nodes.nebbiolo2!.stages.filter((s) => s.status === 'ERROR').map((s) => s.stage)).toEqual(['buildsrc']);
    expect(nodes.lconway!.stages.filter((s) => s.status === 'TIMEOUT').map((s) => s.stage)).toEqual(['checksrc']);
    expect(data.legacy?.propagation).toEqual([]);
    expect(data.registry).toMatchObject({ origin: 'bioconductor', passed_gate: false, archs: [] });
    expect(data.comparison).toEqual([
      { family: 'linux', bbs_nodes: ['nebbiolo2', 'taishan'], bbs_verdict: 'failed', registry_passed: false },
      { family: 'mac', bbs_nodes: ['lconway'], bbs_verdict: 'failed', registry_passed: false },
    ]);
    expect(data.legacy?.version).toBe('2.69.5');
    expect(data.registry?.version).toBe('2.69.0');
    expect(data.same_version).toBe(false);
    expect(summary).toBe(
      "biomaRt 2.69.5 in the legacy build system's devel bioc report (2026-10-23): nebbiolo2 (linux) failed " +
        '(buildsrc ERROR); lconway (mac) failed (checksrc TIMEOUT); taishan (linux) failed (buildsrc ERROR). ' +
        'BBS recorded no propagation for it. ' +
        'The registry propagated 2.69.0 (seeded from Bioconductor, never gated). ' +
        'BBS built 2.69.5; the registry propagated 2.69.0.',
    );
  });

  test('propagated now, newer than the registry: Chromatograms', async () => {
    const { data, summary } = await legacy({ package: 'Chromatograms' });
    expect(data.legacy?.version).toBe('1.3.5');
    expect(data.legacy?.propagation).toEqual([
      { target: 'source', status: 'YES', reason: null },
      { target: 'mac.binary.big-sur-x86_64', status: 'YES', reason: null },
    ]);
    expect(data.registry?.version).toBe('1.3.3');
    expect(data.same_version).toBe(false);
    expect(summary).toContain('BBS propagation: source YES; mac.binary.big-sur-x86_64 YES.');
    expect(summary).toContain('BBS built 1.3.5; the registry propagated 1.3.3.');
  });

  test('blocked by a dependency: cosmosR', async () => {
    const { data, summary } = await legacy({ package: 'cosmosR' });
    expect(data.legacy?.propagation).toEqual([
      { target: 'source', status: 'NO', reason: "package depends on 'decoupleR' which is not available" },
      { target: 'mac.binary.big-sur-x86_64', status: 'UNNEEDED', reason: 'same version is already published' },
    ]);
    expect(data.registry).toBeNull();
    expect(summary).toContain(
      "BBS propagation: source NO (package depends on 'decoupleR' which is not available); " +
        'mac.binary.big-sur-x86_64 UNNEEDED (same version is already published).',
    );
    expect(summary).toContain('cosmosR is not in the bioc propagation index.');
    expect(data.same_version).toBeNull();
  });

  test('unknown archs: RMassBank', async () => {
    const { data, summary } = await legacy({ package: 'RMassBank' });
    for (const node of data.legacy!.nodes) {
      expect(node.verdict).toBe('failed');
      expect(node.stages.filter((s) => s.status === 'ERROR').map((s) => s.stage)).toEqual(['install', 'buildsrc']);
      const checksrc = node.stages.find((s) => s.stage === 'checksrc')!;
      expect(checksrc).toMatchObject({ status: 'skipped', url: null });
      expect(node.stages.find((s) => s.stage === 'install')!.url).not.toBeNull();
    }
    expect(data.legacy?.propagation).toEqual([]);
    expect(data.registry).toMatchObject({ origin: 'r-universe', archs: null, passed_gate: true });
    expect(data.comparison).toEqual([
      { family: 'linux', bbs_nodes: ['nebbiolo2', 'taishan'], bbs_verdict: 'failed', registry_passed: null },
      { family: 'mac', bbs_nodes: ['lconway'], bbs_verdict: 'failed', registry_passed: null },
    ]);
    expect(summary).not.toContain('disagree');
    expect(data.legacy?.version).toBe('3.23.1');
    expect(data.registry?.version).toBe('3.23.0');
    expect(data.same_version).toBe(false);
    expect(summary).toContain('nebbiolo2 (linux) failed (install ERROR, buildsrc ERROR)');
  });

  test('experiment data: adductData', async () => {
    const { envelope, data, fetch } = await legacy({ package: 'adductData' });
    expect(data.legacy).toMatchObject({
      build: 'data-experiment',
      report_url: 'https://bioconductor.org/checkResults/devel/data-experiment-LATEST/adductData/',
    });
    expect(data.legacy?.nodes.map((n) => [n.node, n.verdict])).toEqual([['nebbiolo2', 'ok']]);
    expect(data.registry).toBeNull();
    expect(data.comparison).toEqual([{ family: 'linux', bbs_nodes: ['nebbiolo2'], bbs_verdict: 'ok', registry_passed: null }]);
    expect(data.legacy?.as_of).toBe(iso(bbsUrl('devel', 'data-experiment', 'BUILD_STATUS_DB.txt')));
    expect(envelope.sources[0]).toEqual(bbsSource(bbsUrl('devel', 'data-experiment', 'BUILD_STATUS_DB.txt')));
    expect(fetch.calls).toContain(DEVEL_STATUS);
    expect(fetch.calls).toContain(bbsUrl('devel', 'data-experiment', 'BUILD_STATUS_DB.txt'));
    expect(fetch.calls).not.toContain(bbsUrl('devel', 'workflows', 'BUILD_STATUS_DB.txt'));
    expect(fetch.calls).not.toContain(bbsUrl('devel', 'books', 'BUILD_STATUS_DB.txt'));
  });

  test('not in BBS, in the registry: Fletcher2013a', async () => {
    const { envelope, data, summary } = await legacy({ package: 'Fletcher2013a' });
    expect(data.legacy).toBeNull();
    expect(data.registry).toMatchObject({ version: '1.49.0', origin: 'bioc-build', archs: ['linux'] });
    expect(data.comparison).toEqual([{ family: 'linux', bbs_nodes: [], bbs_verdict: null, registry_passed: true }]);
    expect(data.same_version).toBeNull();
    expect(summary).toBe(
      "Fletcher2013a is in none of the legacy build system's devel reports (bioc, data-experiment, workflows, books). " +
        'The registry propagated 1.49.0 (passed the gate via bioc-build; families linux).',
    );
    expect(envelope.sources).toEqual([...DEVEL_STATUS_URLS.map(bbsSource), { url: BIOC_INDEX_URL, as_of: NOW }]);
  });

  test('release: edgeR', async () => {
    const { envelope, data, fetch } = await legacy({ package: 'edgeR', universe: 'bioc-release' });
    expect(data.universe).toBe('bioc-release');
    expect(data.legacy).toMatchObject({ report: 'release', build: 'bioc', commit: { branch: 'RELEASE_3_23' } });
    expect(data.legacy?.nodes.map((n) => [n.node, n.family, n.verdict])).toEqual([
      ['nebbiolo1', 'linux', 'ok'],
      ['kunpeng2', 'linux', 'ok'],
    ]);
    expect(data.registry?.version).toBe('4.10.7');
    expect(data.comparison).toEqual([
      { family: 'linux', bbs_nodes: ['nebbiolo1', 'kunpeng2'], bbs_verdict: 'ok', registry_passed: true },
      { family: 'mac', bbs_nodes: [], bbs_verdict: null, registry_passed: true },
      { family: 'win', bbs_nodes: [], bbs_verdict: null, registry_passed: true },
    ]);
    expect(data.same_version).toBe(true);
    expect(envelope.sources.at(-1)).toEqual({ url: RELEASE_INDEX_URL, as_of: NOW });
    for (const url of fetch.calls.filter((u) => u.includes('/checkResults/'))) expect(url).toContain('/release/');
    expect(fetch.calls).not.toContain(DEVEL_STATUS);
  });

  test('NA status: xcms in release', async () => {
    const { data, summary } = await legacy({ package: 'xcms', universe: 'bioc-release' });
    const kunpeng2 = data.legacy!.nodes.find((n) => n.node === 'kunpeng2')!;
    expect(kunpeng2.verdict).toBe('incomplete');
    expect(kunpeng2.stages.find((s) => s.status === 'NA')!.url).toBe(
      'https://bioconductor.org/checkResults/release/bioc-LATEST/xcms/kunpeng2-checksrc.html',
    );
    expect(summary).toContain('kunpeng2 (linux) incomplete (checksrc NA)');
    expect(data.comparison).toEqual([
      { family: 'linux', bbs_nodes: ['nebbiolo1', 'kunpeng2'], bbs_verdict: 'incomplete', registry_passed: null },
    ]);
    expect(data.registry).toBeNull();
  });

  test('tester case, disagree on mac: BBS ok, registry did not pass mac (Chromatograms, live index)', async () => {
    const { data, summary } = await legacy({ package: 'Chromatograms' }, liveIndexRoutes);
    expect(data.legacy!.nodes.map((n) => n.verdict)).toEqual(['ok', 'ok', 'ok']);
    expect(data.legacy!.propagation.map((p) => p.status)).toEqual(['YES', 'YES']);
    expect(data.registry).toMatchObject({ version: '1.3.5', origin: 'r-universe', archs: ['linux', 'win'] });
    expect(data.comparison).toEqual([
      { family: 'linux', bbs_nodes: ['nebbiolo2', 'taishan'], bbs_verdict: 'ok', registry_passed: true },
      { family: 'mac', bbs_nodes: ['lconway'], bbs_verdict: 'ok', registry_passed: false },
      { family: 'win', bbs_nodes: [], bbs_verdict: null, registry_passed: true },
    ]);
    expect(data.same_version).toBe(true);
    expect(summary).toBe(
      "Chromatograms 1.3.5 in the legacy build system's devel bioc report (2026-10-23): nebbiolo2 (linux) ok; " +
        'lconway (mac) ok; taishan (linux) ok. BBS propagation: source YES; mac.binary.big-sur-x86_64 YES. ' +
        'The registry propagated 1.3.5 (passed the gate via r-universe; families linux, win). ' +
        'BBS and the registry disagree on mac (BBS ok, registry not passed).',
    );
  });

  test('disagree on linux, warnings elsewhere: affxparser (live index)', async () => {
    const { data, summary } = await legacy({ package: 'affxparser' }, liveIndexRoutes);
    const verdicts = Object.fromEntries(data.legacy!.nodes.map((n) => [n.node, n.verdict]));
    expect(verdicts).toEqual({ nebbiolo2: 'ok', lconway: 'ok', taishan: 'failed' });
    expect(data.legacy!.propagation.map((p) => p.status)).toEqual(['UNNEEDED', 'UNNEEDED']);
    expect(data.registry).toMatchObject({ version: '1.85.1', archs: ['linux', 'win', 'mac'] });
    expect(data.comparison).toEqual([
      { family: 'linux', bbs_nodes: ['nebbiolo2', 'taishan'], bbs_verdict: 'failed', registry_passed: true },
      { family: 'mac', bbs_nodes: ['lconway'], bbs_verdict: 'ok', registry_passed: true },
      { family: 'win', bbs_nodes: [], bbs_verdict: null, registry_passed: true },
    ]);
    expect(data.same_version).toBe(true);
    expect(summary).toContain('nebbiolo2 (linux) ok (checksrc WARNINGS)');
    expect(summary).toContain('lconway (mac) ok (checksrc WARNINGS)');
    expect(summary).toContain('taishan (linux) failed (checksrc ERROR)');
    expect(summary).toContain('BBS and the registry disagree on linux (BBS failed, registry passed).');
  });

  test('timeout on mac, archs unknown: SEMPLR', async () => {
    const { envelope, data, summary } = await legacy({ package: 'SEMPLR' });
    const lconway = data.legacy!.nodes.find((n) => n.node === 'lconway')!;
    expect(lconway.verdict).toBe('failed');
    expect(lconway.stages.find((s) => s.stage === 'checksrc')).toMatchObject({ status: 'TIMEOUT' });
    expect(lconway.stages.find((s) => s.stage === 'buildbin')).toMatchObject({ status: 'OK', url: null });
    expect(data.legacy!.nodes.filter((n) => n.verdict === 'ok').map((n) => n.node)).toEqual(['nebbiolo2', 'taishan']);
    expect(data.legacy!.propagation).toEqual([
      { target: 'source', status: 'UNNEEDED', reason: 'same version is already published' },
    ]);
    expect(data.registry).toMatchObject({ version: '1.1.2', origin: 'r-universe', archs: null });
    expect(data.comparison).toEqual([
      { family: 'linux', bbs_nodes: ['nebbiolo2', 'taishan'], bbs_verdict: 'ok', registry_passed: null },
      { family: 'mac', bbs_nodes: ['lconway'], bbs_verdict: 'failed', registry_passed: null },
    ]);
    expect(summary).not.toContain('disagree');
    expect(summary).not.toContain('BBS built');
    expect(envelopeBytes(envelope)).toBeLessThan(MAX_RESULT_BYTES);
  });

  test('in BBS only, failing everywhere: BiocSet', async () => {
    const { data, summary } = await legacy({ package: 'BiocSet' });
    expect(data.legacy!.nodes.map((n) => n.verdict)).toEqual(['failed', 'failed', 'failed']);
    expect(data.legacy!.nodes.every((n) => n.stages.find((s) => s.stage === 'buildsrc')!.status === 'ERROR')).toBe(true);
    const buildbin = data.legacy!.nodes.find((n) => n.node === 'lconway')!.stages.find((s) => s.stage === 'buildbin')!;
    expect(buildbin).toMatchObject({ status: 'skipped', url: null });
    expect(summary).toContain('BBS recorded no propagation for it.');
    expect(summary).toContain('BiocSet is not in the bioc propagation index.');
    expect(data.registry).toBeNull();
    expect(data.comparison).toEqual([
      { family: 'linux', bbs_nodes: ['nebbiolo2', 'taishan'], bbs_verdict: 'failed', registry_passed: null },
      { family: 'mac', bbs_nodes: ['lconway'], bbs_verdict: 'failed', registry_passed: null },
    ]);
    expect(data.same_version).toBeNull();
  });

  test('unknown name close to a BBS and index name: Chromatogram', async () => {
    const { error } = await failure({ package: 'Chromatogram' });
    expect(error.code).toBe('not_found');
    expect(error.message).toContain('Did you mean: Chromatograms?');
  });

  test('unknown name: trackViewr', async () => {
    const { error, fetch } = await failure({ package: 'trackViewr' });
    expect(error.code).toBe('not_found');
    expect(error.message).toContain('Did you mean: trackViewer?');
    expect(error.message).toContain('Package names are case-sensitive.');
    expect(error.message.endsWith(" To check release, call again with universe 'bioc-release'.")).toBe(true);
    expect(sorted(fetch.calls)).toEqual(sorted([BIOC_INDEX_URL, ...DEVEL_STATUS_URLS]));
  });

  test('an unknown release name names the devel universe', async () => {
    // Only release/bioc is recorded; the other builds' files get a one-package stand-in.
    const otherBuilds = Object.fromEntries(
      (['data-experiment', 'workflows', 'books'] as const).map((build) => [
        bbsUrl('release', build, 'BUILD_STATUS_DB.txt'),
        { status: 200, body: 'zzz4#n1#install: OK\n' } as FixtureRoute,
      ]),
    );
    const { error } = await failure({ package: 'trackViewr', universe: 'bioc-release' }, otherBuilds);
    expect(error.code).toBe('not_found');
    expect(error.message.endsWith(" To check devel, call again with universe 'bioc'.")).toBe(true);
  });
});

describe('pkg_legacy_status size', () => {
  test('a worst case of 5 nodes with every stage failing stays under the limit', async () => {
    const name = 'Abcdefghijklmnopqrstuvwxyzabcdefghijklmn';
    expect(name).toHaveLength(40);
    const nodes = ['n1', 'n2', 'n3', 'n4', 'n5'];
    const stages = ['install', 'buildsrc', 'checksrc', 'buildbin'];
    const reason = 'package depends on a package which is not available, and ' + 'x'.repeat(23);
    expect(reason).toHaveLength(80);
    const body = (text: string): FixtureRoute => ({ status: 200, body: text, headers: { 'last-modified': 'Fri, 23 Oct 2026 16:51:07 GMT' } });
    const routes: Record<string, FixtureRoute> = {
      [DEVEL_STATUS]: body(nodes.flatMap((n) => stages.map((s) => `${name}#${n}#${s}: ERROR`)).join('\n') + '\n'),
      [DEVEL_PROPAGATION]: body(
        ['source', 'mac.binary.big-sur-x86_64', 'win.binary.x86_64']
          .map((t) => `${name}#${t}#propagate: NO, ${reason}`)
          .join('\n') + '\n',
      ),
      [infoUrl(name)]: body(
        `Package: ${name}\nVersion: 10.20.30\ngit_branch: devel\ngit_last_commit: 602809b\ngit_last_commit_date: 2026-09-29 15:32:11 -0400 (Tue, 29 Sep 2026)\n`,
      ),
      ...Object.fromEntries(
        nodes.map((n) => [
          nodeUrl(n),
          body(
            `<TR><TD><B>Hostname:&nbsp;</B></TD><TD>${n}</TD></TR><TR><TD><B>OS:&nbsp;</B></TD><TD>Windows Server 2022 Datacenter</TD></TR>` +
              '<TR><TD><B>Arch:&nbsp;</B></TD><TD>x86_64</TD></TR>',
          ),
        ]),
      ),
      [BIOC_INDEX_URL]: {
        status: 200,
        body: JSON.stringify({
          [name]: {
            version: '10.20.29',
            sha256: 'a'.repeat(64),
            ts: '2026-10-22T19:55:41.044Z',
            artifacts: [],
            archs: ['linux', 'win', 'mac'],
          },
        }),
      },
    };
    const { fetch, deps } = setup(routes);
    const { result } = await invoke({ package: name }, deps);
    if (!result.ok) throw result.error;
    const envelope = result.envelope as Envelope<Data>;
    expect(envelope.data.legacy!.nodes).toHaveLength(5);
    expect(envelope.data.legacy!.nodes.every((n) => n.stages.length === 4 && n.family === 'win')).toBe(true);
    expect(envelope.data.legacy!.propagation).toHaveLength(3);
    expect(fetch.calls).toHaveLength(1 + 1 + 1 + 1 + 5);
    expect(envelopeBytes(envelope)).toBeLessThan(MAX_RESULT_BYTES);
  });
});

describe('pkg_legacy_status memo', () => {
  test('two calls within 3600 s request each shared file once; after it, again', async () => {
    const { fetch, deps, clock } = setup();
    const count = (url: string) => fetch.calls.filter((u) => u === url).length;
    await invoke({ package: 'trackViewer' }, deps);
    await invoke({ package: 'GEOfastq' }, deps);
    expect(count(DEVEL_STATUS)).toBe(1);
    expect(count(DEVEL_PROPAGATION)).toBe(1);
    for (const node of ['nebbiolo2', 'lconway', 'taishan']) expect(count(nodeUrl(node))).toBe(1);
    clock.ms += 3600 * 1000;
    await invoke({ package: 'trackViewer' }, deps);
    expect(count(DEVEL_STATUS)).toBe(2);
    expect(count(DEVEL_PROPAGATION)).toBe(2);
  });
});

describe('pkg_legacy_status upstream failures', () => {
  const garbage = (body: string): FixtureRoute => ({ status: 200, body });

  test.each([
    ['a 500', { status: 500, body: 'oops' } as FixtureRoute, 'upstream_error', undefined],
    ['a 404', { status: 404, body: 'nope' } as FixtureRoute, 'upstream_error', 'has no BBS build status file'],
    ['a garbage line', garbage('garbage\n'), 'upstream_error', 'unexpected format'],
    ['only blank lines', garbage('\n  \n\n'), 'upstream_error', 'with no packages'],
  ])('the devel bioc build status file returning %s fails the call', async (_label, route, code, message) => {
    const { error } = await failure({ package: 'trackViewer' }, { [DEVEL_STATUS]: route });
    expect(error.code).toBe(code);
    if (message) expect(error.message).toContain(message);
  });

  test('a build status fetch timing out is upstream_timeout', async () => {
    const inner = fixtureFetch(ROUTES);
    const now = () => new Date(NOW);
    const fetch: FetchFn = (request) =>
      request.url === DEVEL_STATUS ? Promise.reject(new DOMException('timed out', 'TimeoutError')) : inner(request);
    const deps: Deps = { fetch, cache: createMemoryCache(now), now, env: {} };
    const { result } = await invoke({ package: 'trackViewer' }, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('upstream_timeout');
  });

  test('the propagation status file returning 404 fails the call', async () => {
    const { error } = await failure({ package: 'trackViewer' }, { [DEVEL_PROPAGATION]: NOT_FOUND });
    expect(error.code).toBe('upstream_error');
    expect(error.message).toContain('has no BBS propagation status file');
  });

  test('an info.dcf naming another package fails the call', async () => {
    const { error } = await failure(
      { package: 'trackViewer' },
      { [infoUrl('trackViewer')]: { status: 200, body: 'Package: other\nVersion: 1.0.0\n' } },
    );
    expect(error.code).toBe('upstream_error');
    expect(error.message).toContain('expected "trackViewer"');
  });

  test('a 404 info.dcf gives a null version and commit and still succeeds', async () => {
    const { data, summary } = await legacy({ package: 'trackViewer' }, { [infoUrl('trackViewer')]: NOT_FOUND });
    expect(data.legacy).toMatchObject({ version: null, commit: null });
    expect(data.same_version).toBeNull();
    expect(summary.startsWith("trackViewer (version unknown) in the legacy build system's devel bioc report")).toBe(true);
    expect(summary).not.toContain('BBS built');
  });

  test('a 404 NodeInfo page for lconway nulls the node enrichment and drops its source', async () => {
    const { envelope, data } = await legacy({ package: 'GEOfastq' }, { [nodeUrl('lconway')]: NOT_FOUND });
    const lconway = data.legacy!.nodes.find((n) => n.node === 'lconway')!;
    expect(lconway).toMatchObject({ os: null, arch: null, family: null, verdict: 'ok' });
    expect(envelope.sources.map((s) => s.url)).not.toContain(nodeUrl('lconway'));
    // GEOfastq's registry archs include mac, so the row stays because the registry passed it.
    expect(data.comparison.find((c) => c.family === 'mac')).toEqual({
      family: 'mac',
      bbs_nodes: [],
      bbs_verdict: null,
      registry_passed: true,
    });
    const biomaRt = await legacy({ package: 'biomaRt' }, { [nodeUrl('lconway')]: NOT_FOUND });
    expect(biomaRt.data.comparison.map((c) => c.family)).toEqual(['linux']);
  });
});

test('the description names pkg_status and pkg_check_output', () => {
  expect(pkgLegacyStatus.description).toContain('pkg_status');
  expect(pkgLegacyStatus.description).toContain('pkg_check_output');
});
