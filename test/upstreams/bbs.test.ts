import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { Deps } from '../../src/core/deps';
import { CapabilityError } from '../../src/errors';
import {
  bbsCommitTime,
  bbsNodeInfoPath,
  bbsPackagePath,
  bbsReportPath,
  bbsStageUrl,
  getBbsBuildStatus,
  getBbsNodeInfo,
  getBbsPackageInfo,
  getBbsPropagationStatus,
  parseBbsInfoDcf,
  parseBbsNodeInfo,
  parseBuildStatusDb,
  parsePropagationStatusDb,
} from '../../src/upstreams/bbs';
import { createMemoryCache } from '../../src/upstreams/cache';
import { bbsRoutes, bbsUrl } from '../support/bbs-routes';
import { fixtureFetch, type FixtureRoute } from '../support/fixture-fetch';

const CHECK_RESULTS = join(import.meta.dirname, '..', 'fixtures', 'bioconductor', 'checkResults');
const fixture = (path: string) => readFileSync(join(CHECK_RESULTS, path), 'utf8');

const BUILD_STATUS_URL = bbsUrl('devel', 'bioc', 'BUILD_STATUS_DB.txt');
const URL = BUILD_STATUS_URL;
const PROPAGATION_URL = bbsUrl('devel', 'bioc', 'PROPAGATION_STATUS_DB.txt');

function setup(routes: Record<string, FixtureRoute> = bbsRoutes, clock = { ms: Date.parse('2026-10-24T12:00:00Z') }) {
  const fetch = fixtureFetch(routes);
  const now = () => new Date(clock.ms);
  const deps: Deps = { fetch, cache: createMemoryCache(now), now, env: {} };
  return { fetch, deps, clock };
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

function errorOfSync(run: () => unknown): CapabilityError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CapabilityError);
    return error as CapabilityError;
  }
  throw new Error('expected a CapabilityError');
}

describe('paths', () => {
  test('bbsReportPath', () => {
    expect(bbsReportPath('devel', 'bioc')).toBe('checkResults/devel/bioc-LATEST/');
  });

  test('bbsPackagePath encodes the name and rejects a path-climbing one', () => {
    expect(bbsPackagePath('devel', 'bioc', 'a.b')).toBe('checkResults/devel/bioc-LATEST/a.b/');
    expect(errorOfSync(() => bbsPackagePath('devel', 'bioc', '..')).code).toBe('invalid_input');
  });

  test('bbsStageUrl is an absolute URL', () => {
    expect(bbsStageUrl('devel', 'bioc', 'GEOfastq', 'taishan', 'checksrc')).toBe(
      'https://bioconductor.org/checkResults/devel/bioc-LATEST/GEOfastq/taishan-checksrc.html',
    );
  });

  test('bbsNodeInfoPath', () => {
    expect(bbsNodeInfoPath('devel', 'bioc', 'nebbiolo2')).toBe('checkResults/devel/bioc-LATEST/nebbiolo2-NodeInfo.html');
  });
});

describe('parseBuildStatusDb', () => {
  test('the devel bioc fixture gives nine packages, and trackViewer has 10 lines in file order', () => {
    const packages = parseBuildStatusDb(fixture('devel/bioc-LATEST/BUILD_STATUS_DB.txt'), URL);
    expect(packages.size).toBe(9);
    const lines = packages.get('trackViewer')!;
    expect(lines).toHaveLength(10);
    expect(lines.map((l) => `${l.node}#${l.stage}`)).toEqual([
      'nebbiolo2#install',
      'nebbiolo2#buildsrc',
      'nebbiolo2#checksrc',
      'lconway#install',
      'lconway#buildsrc',
      'lconway#checksrc',
      'lconway#buildbin',
      'taishan#install',
      'taishan#buildsrc',
      'taishan#checksrc',
    ]);
    expect(lines[0]).toEqual({ node: 'nebbiolo2', stage: 'install', status: 'OK' });
  });

  test('CRLF line endings parse, and blank lines are skipped', () => {
    const packages = parseBuildStatusDb('a4#n#install: OK\r\n\r\na4#n#buildsrc: ERROR\r\n  \r\n', URL);
    expect(packages.get('a4')).toEqual([
      { node: 'n', stage: 'install', status: 'OK' },
      { node: 'n', stage: 'buildsrc', status: 'ERROR' },
    ]);
  });

  test('a package name with dots parses', () => {
    expect(parseBuildStatusDb('org.Hs.eg.db#n#install: OK\n', URL).has('org.Hs.eg.db')).toBe(true);
  });

  test.each(['a4#n#install: NOT OK', 'garbage', 'a4#n#install:OK', '#n#install: OK'])('%j is upstream_error', (line) => {
    const error = errorOfSync(() => parseBuildStatusDb(line + '\n', URL));
    expect(error.code).toBe('upstream_error');
    expect(error.message).toBe(`bioconductor.org returned a BBS build status file in an unexpected format (${URL})`);
    expect(error.details).toEqual({ upstream: 'bioconductor', url: URL });
  });

  test('a repeated package#node#stage is upstream_error', () => {
    const error = errorOfSync(() => parseBuildStatusDb('a4#n#install: OK\na4#n#install: ERROR\n', URL));
    expect(error.code).toBe('upstream_error');
  });
});

describe('parsePropagationStatusDb', () => {
  const PURL = PROPAGATION_URL;

  test('YES gives a null reason', () => {
    expect(parsePropagationStatusDb('a4#source#propagate: YES\n', PURL).get('a4')).toEqual([
      { target: 'source', status: 'YES', reason: null },
    ]);
  });

  test("NO splits at the first ', '", () => {
    const body = "cosmosR#source#propagate: NO, package depends on 'decoupleR' which is not available\n";
    expect(parsePropagationStatusDb(body, PURL).get('cosmosR')).toEqual([
      { target: 'source', status: 'NO', reason: "package depends on 'decoupleR' which is not available" },
    ]);
  });

  test('the recorded file keeps file order per package', () => {
    const packages = parsePropagationStatusDb(fixture('devel/bioc-LATEST/PROPAGATION_STATUS_DB.txt'), PURL);
    expect(packages.get('trackViewer')).toEqual([
      { target: 'source', status: 'UNNEEDED', reason: 'same version is already published' },
      { target: 'mac.binary.big-sur-x86_64', status: 'UNNEEDED', reason: 'same version is already published' },
    ]);
  });

  test('a malformed line is upstream_error', () => {
    const error = errorOfSync(() => parsePropagationStatusDb('a4#source#build: YES\n', PURL));
    expect(error.code).toBe('upstream_error');
    expect(error.message).toBe(`bioconductor.org returned a BBS propagation status file in an unexpected format (${PURL})`);
  });

  test('an empty body gives an empty map', () => {
    expect(parsePropagationStatusDb('', PURL).size).toBe(0);
  });
});

describe('parseBbsInfoDcf', () => {
  const INFO_URL = bbsUrl('devel', 'bioc', 'trackViewer/raw-results/info.dcf');

  test('the trackViewer fixture parses', () => {
    expect(
      parseBbsInfoDcf(fixture('devel/bioc-LATEST/trackViewer/raw-results/info.dcf'), 'trackViewer', INFO_URL),
    ).toEqual({
      version: '1.49.3',
      commit: { id: '602809b', time: '2026-09-29T15:32:11-04:00', branch: 'devel' },
    });
  });

  test('Maintainer and MaintainerEmail are never read', () => {
    const body =
      'Package: trackViewer\nVersion: 1.49.3\nMaintainer: Someone <someone@example.org>\nMaintainerEmail: someone at example.org\n' +
      'git_branch: devel\ngit_last_commit: 602809b\ngit_last_commit_date: 2026-09-29 15:32:11 -0400 (Tue, 29 Sep 2026)\n';
    const parsed = parseBbsInfoDcf(body, 'trackViewer', INFO_URL);
    expect(JSON.stringify(parsed)).not.toMatch(/someone|Maintainer/);
  });

  test('a Package mismatch is upstream_error with the expected name', () => {
    const error = errorOfSync(() => parseBbsInfoDcf('Package: other\nVersion: 1.0.0\n', 'trackViewer', INFO_URL));
    expect(error.code).toBe('upstream_error');
    expect(error.message).toBe(`bioconductor.org returned info.dcf for "other" at ${INFO_URL}, expected "trackViewer"`);
  });

  test('a bad Version is upstream_error', () => {
    const error = errorOfSync(() => parseBbsInfoDcf('Package: trackViewer\nVersion: abc\n', 'trackViewer', INFO_URL));
    expect(error.message).toBe(`bioconductor.org returned a BBS info.dcf in an unexpected format (${INFO_URL})`);
  });

  test.each(['', 'git_last_commit: nothex\n', 'git_last_commit: abc\n'])('commit is null for %j', (extra) => {
    expect(parseBbsInfoDcf(`Package: trackViewer\nVersion: 1.0.0\n${extra}`, 'trackViewer', INFO_URL).commit).toBeNull();
  });

  test('an empty git_branch is null and an unparseable date gives a null time', () => {
    const body = 'Package: trackViewer\nVersion: 1.0.0\ngit_branch:\ngit_last_commit: 602809b\ngit_last_commit_date: yesterday\n';
    expect(parseBbsInfoDcf(body, 'trackViewer', INFO_URL).commit).toEqual({ id: '602809b', time: null, branch: null });
  });

  test('the first occurrence of a field wins and continuation lines are ignored', () => {
    const body = 'Package: trackViewer\nVersion: 1.0.0\nVersion: 2.0.0\nDepends: R\n  extra\n';
    expect(parseBbsInfoDcf(body, 'trackViewer', INFO_URL).version).toBe('1.0.0');
  });

  test('a second stanza is upstream_error', () => {
    const error = errorOfSync(() =>
      parseBbsInfoDcf('Package: trackViewer\nVersion: 1.0.0\n\nPackage: other\nVersion: 1.0.0\n', 'trackViewer', INFO_URL),
    );
    expect(error.code).toBe('upstream_error');
  });
});

describe('bbsCommitTime', () => {
  test.each([
    ['2026-04-28 08:35:24 -0400 (Tue, 28 Apr 2026)', '2026-04-28T08:35:24-04:00'],
    ['2026-04-28 08:35:24 +0530 (Tue, 28 Apr 2026)', '2026-04-28T08:35:24+05:30'],
    ['', null],
    ['yesterday', null],
    ['2026-13-45 08:35:24 -0400', null],
  ])('%j → %j', (input, expected) => {
    expect(bbsCommitTime(input)).toBe(expected);
  });
});

describe('parseBbsNodeInfo', () => {
  test.each([
    ['devel/bioc-LATEST/nebbiolo2', 'Linux (Ubuntu 24.04.4 LTS)', 'x86_64'],
    ['devel/bioc-LATEST/lconway', 'macOS 12.7.6 Monterey', 'x86_64'],
    ['devel/bioc-LATEST/taishan', 'Linux (openEuler 24.03 LTS)', 'aarch64'],
    ['release/bioc-LATEST/nebbiolo1', 'Linux (Ubuntu 24.04.4 LTS)', 'x86_64'],
    ['release/bioc-LATEST/kunpeng2', 'Linux (openEuler 24.03 LTS)', 'aarch64'],
  ])('%s', (path, os, arch) => {
    const node = path.split('/').pop()!;
    expect(parseBbsNodeInfo(fixture(`${path}-NodeInfo.html`), node)).toEqual({ os, arch });
  });

  test('a page for another host is null', () => {
    expect(parseBbsNodeInfo(fixture('devel/bioc-LATEST/nebbiolo2-NodeInfo.html'), 'lconway')).toBeNull();
  });

  test('a page without an OS row is null', () => {
    const html = '<TR><TD><B>Hostname:&nbsp;</B></TD><TD>n1</TD></TR><TR><TD><B>Arch:&nbsp;</B></TD><TD>x86_64</TD></TR>';
    expect(parseBbsNodeInfo(html, 'n1')).toBeNull();
  });

  test('entities and tags in the OS cell are decoded', () => {
    const html =
      '<TR><TD><B>Hostname:&nbsp;</B></TD><TD>n1</TD></TR><TR><TD><B>OS:&nbsp;</B></TD><TD>Linux&nbsp;<I>A &amp; B</I></TD></TR>' +
      '<TR><TD><B>Arch:&nbsp;</B></TD><TD>x86_64</TD></TR>';
    expect(parseBbsNodeInfo(html, 'n1')).toEqual({ os: 'Linux A & B', arch: 'x86_64' });
  });
});

describe('getBbsBuildStatus', () => {
  test('a memo hit makes no second fetch and reports fromCache', async () => {
    const { fetch, deps } = setup();
    const first = await getBbsBuildStatus(deps, 'devel', 'bioc');
    expect(first.response.fromCache).toBe(false);
    expect(first.response.url).toBe(BUILD_STATUS_URL);
    expect(first.response.lastModified).toBe('2026-10-23T16:51:07.000Z');
    expect('body' in first.response).toBe(false);
    const second = await getBbsBuildStatus(deps, 'devel', 'bioc');
    expect(second.response.fromCache).toBe(true);
    expect(second.packages).toBe(first.packages);
    expect(fetch.calls).toEqual([BUILD_STATUS_URL]);
  });

  test('two concurrent cold calls make one fetch', async () => {
    const { fetch, deps } = setup();
    await Promise.all([getBbsBuildStatus(deps, 'devel', 'bioc'), getBbsBuildStatus(deps, 'devel', 'bioc')]);
    expect(fetch.calls).toEqual([BUILD_STATUS_URL]);
  });

  test('a 404 is upstream_error saying there is no build status file', async () => {
    const { deps } = setup({ [BUILD_STATUS_URL]: { status: 404, body: 'nope' } });
    const error = await errorOf(getBbsBuildStatus(deps, 'devel', 'bioc'));
    expect(error.code).toBe('upstream_error');
    expect(error.message).toBe(`bioconductor.org has no BBS build status file at ${BUILD_STATUS_URL}`);
    expect(error.details).toEqual({ upstream: 'bioconductor', url: BUILD_STATUS_URL });
  });

  test('an empty file is upstream_error', async () => {
    const { deps } = setup({ [BUILD_STATUS_URL]: { status: 200, body: '\n  \n' } });
    const error = await errorOf(getBbsBuildStatus(deps, 'devel', 'bioc'));
    expect(error.message).toBe(`bioconductor.org returned a BBS build status file with no packages (${BUILD_STATUS_URL})`);
  });

  test('a 500 is not memoized', async () => {
    const routes: Record<string, FixtureRoute> = { [BUILD_STATUS_URL]: { status: 500, body: 'oops' } };
    const { fetch, deps } = setup(routes);
    expect((await errorOf(getBbsBuildStatus(deps, 'devel', 'bioc'))).code).toBe('upstream_error');
    routes[BUILD_STATUS_URL] = bbsRoutes[BUILD_STATUS_URL]!;
    expect((await getBbsBuildStatus(deps, 'devel', 'bioc')).packages.size).toBe(9);
    expect(fetch.calls).toHaveLength(2);
  });
});

describe('getBbsPropagationStatus', () => {
  test('parses the recorded file, memoized', async () => {
    const { fetch, deps } = setup();
    const first = await getBbsPropagationStatus(deps, 'devel', 'bioc');
    expect(first.packages.get('Chromatograms')).toHaveLength(2);
    expect(first.response.lastModified).toBe('2026-10-23T16:51:17.000Z');
    const second = await getBbsPropagationStatus(deps, 'devel', 'bioc');
    expect(second.response.fromCache).toBe(true);
    expect(fetch.calls).toEqual([PROPAGATION_URL]);
  });

  test('a 404 is upstream_error; an empty file is allowed', async () => {
    const { deps } = setup({ [PROPAGATION_URL]: { status: 404, body: 'nope' } });
    const error = await errorOf(getBbsPropagationStatus(deps, 'devel', 'bioc'));
    expect(error.message).toBe(`bioconductor.org has no BBS propagation status file at ${PROPAGATION_URL}`);
    const empty = setup({ [PROPAGATION_URL]: { status: 200, body: '' } });
    expect((await getBbsPropagationStatus(empty.deps, 'devel', 'bioc')).packages.size).toBe(0);
  });
});

describe('getBbsPackageInfo and getBbsNodeInfo', () => {
  test('info.dcf is parsed; a 404 gives undefined; a 500 propagates', async () => {
    const { deps } = setup();
    const info = await getBbsPackageInfo(deps, 'devel', 'bioc', 'trackViewer');
    expect(info).toMatchObject({ version: '1.49.3', commit: { id: '602809b' } });
    expect(info?.response.url).toBe(bbsUrl('devel', 'bioc', 'trackViewer/raw-results/info.dcf'));

    const missing = setup({ [bbsUrl('devel', 'bioc', 'x4/raw-results/info.dcf')]: { status: 404, body: 'nope' } });
    expect(await getBbsPackageInfo(missing.deps, 'devel', 'bioc', 'x4')).toBeUndefined();
    const broken = setup({ [bbsUrl('devel', 'bioc', 'x4/raw-results/info.dcf')]: { status: 500, body: 'oops' } });
    expect((await errorOf(getBbsPackageInfo(broken.deps, 'devel', 'bioc', 'x4'))).code).toBe('upstream_error');
  });

  test('a NodeInfo page is parsed; a 404 gives undefined; a 500 propagates', async () => {
    const { deps } = setup();
    const info = await getBbsNodeInfo(deps, 'devel', 'bioc', 'lconway');
    expect(info?.spec).toEqual({ os: 'macOS 12.7.6 Monterey', arch: 'x86_64' });

    const url = bbsUrl('devel', 'bioc', 'lconway-NodeInfo.html');
    expect(await getBbsNodeInfo(setup({ [url]: { status: 404, body: 'nope' } }).deps, 'devel', 'bioc', 'lconway')).toBeUndefined();
    const broken = setup({ [url]: { status: 500, body: 'oops' } });
    expect((await errorOf(getBbsNodeInfo(broken.deps, 'devel', 'bioc', 'lconway'))).code).toBe('upstream_error');
  });
});
