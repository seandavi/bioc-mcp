import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import type { Deps } from '../../src/core/deps';
import { CapabilityError } from '../../src/errors';
import { bioconductorUpstream } from '../../src/upstreams/bioconductor';
import { createMemoryCache } from '../../src/upstreams/cache';
import type { Upstream } from '../../src/upstreams/http';
import { cranUpstream } from '../../src/upstreams/cran';
import { getPackagesFile, parsePackagesFile } from '../../src/upstreams/packages-file';
import { packagesUrl, readBiocFixture } from '../support/bioconductor-routes';
import { CRAN_PACKAGES_URL, depsRoutes } from '../support/deps-routes';
import { fixtureFetch, type FixtureRoute } from '../support/fixture-fetch';

const CRAN_FIXTURE = readFileSync(join(import.meta.dirname, '..', 'fixtures', 'cran', 'src', 'contrib', 'PACKAGES'), 'utf8');

function setup(routes: Record<string, FixtureRoute> = depsRoutes, clock = { ms: Date.parse('2026-10-22T12:00:00Z') }) {
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

describe('parsePackagesFile', () => {
  const URL = CRAN_PACKAGES_URL;
  const BIOC_URL = packagesUrl('3.24', 'bioc');
  const stanza = (name: string, version: string, extra = '') =>
    `Package: ${name}\nVersion: ${version}\nDepends: R (>= 4.0)\n${extra}`;
  const pathStanza = (name: string, version: string, path = '4.7.0/Recommended') =>
    stanza(name, version, `Path: ${path}\n`);
  const parse = (body: string) => parsePackagesFile(body, cranUpstream, URL);

  function errorOfParse(body: string, upstream: Upstream, url: string): unknown {
    try {
      parsePackagesFile(body, upstream, url);
    } catch (error) {
      return error;
    }
    return undefined;
  }

  test('the CRAN fixture has 200 Package: lines and 186 entries, in order of first appearance', () => {
    const lines = CRAN_FIXTURE.match(/^Package: (.*)$/gm)!;
    expect(lines).toHaveLength(200);
    const versions = parse(CRAN_FIXTURE);
    expect(versions.size).toBe(186);
    expect(versions.get('MASS')).toBe('7.3-66');
    expect([...versions.keys()]).toEqual([...new Set(lines.map((line) => line.slice('Package: '.length).trim()))]);
  });

  test('the recorded 3.24 software file gives its ten packages in file order', () => {
    const versions = parsePackagesFile(
      readBiocFixture('packages/3.24/bioc/src/contrib/PACKAGES'),
      bioconductorUpstream,
      BIOC_URL,
    );
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
    expect([...parse(body)]).toEqual([['abc', '1.0']]);
  });

  test('CRLF bodies parse the same', () => {
    const body = stanza('abc', '1.0') + '\n' + stanza('def', '2.0-1');
    expect(parse(body.replaceAll('\n', '\r\n'))).toEqual(parse(body));
  });

  test('ignores a trailing space after the name', () => {
    expect([...parse('Package: abc \nVersion: 1\n')]).toEqual([['abc', '1']]);
  });

  test('an indented Package: line is a continuation and is ignored', () => {
    const body = 'Package: real\nVersion: 1\nDescription: see\n  Package: nested\nDepends: x\n  Package: indented\n';
    expect([...parse(body)]).toEqual([['real', '1']]);
  });

  test('consecutive blank lines are allowed; empty and blank bodies give an empty Map', () => {
    expect([...parse(stanza('abc', '1.0') + '\n\n \n' + stanza('def', '2.0')).keys()]).toEqual(['abc', 'def']);
    expect(parse('').size).toBe(0);
    expect(parse('\n\n  \n').size).toBe(0);
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
    const error = errorOfParse(body, bioconductorUpstream, BIOC_URL);
    expect(error).toBeInstanceOf(CapabilityError);
    expect((error as CapabilityError).code).toBe('upstream_error');
    expect((error as CapabilityError).message).toContain(BIOC_URL);
    expect((error as CapabilityError).details).toEqual({ upstream: 'bioconductor', url: BIOC_URL });
  });

  test('a violation under CRAN names CRAN and its URL', () => {
    const error = errorOfParse('Version: 1.0\n', cranUpstream, CRAN_PACKAGES_URL) as CapabilityError;
    expect(error).toBeInstanceOf(CapabilityError);
    expect(error.message).toBe(`CRAN returned a PACKAGES file in an unexpected format (${CRAN_PACKAGES_URL})`);
    expect(error.details).toEqual({ upstream: 'cran', url: CRAN_PACKAGES_URL });
  });

  describe('Path stanzas', () => {
    test('the stanza without Path gives the version when it comes first', () => {
      expect([...parse(stanza('MASS', '7.3-66') + '\n' + pathStanza('MASS', '7.3-65'))]).toEqual([['MASS', '7.3-66']]);
    });

    test('the stanza without Path gives the version when it comes last, and the name keeps its first position', () => {
      const body = [pathStanza('MASS', '7.3-65'), stanza('abc', '1.0'), stanza('MASS', '7.3-66')].join('\n');
      expect([...parse(body)]).toEqual([
        ['MASS', '7.3-66'],
        ['abc', '1.0'],
      ]);
    });

    test('a name only in Path stanzas takes the first one', () => {
      const body = pathStanza('MASS', '7.3-65') + '\n' + pathStanza('MASS', '7.3-64', '4.6.2/Recommended');
      expect([...parse(body)]).toEqual([['MASS', '7.3-65']]);
    });

    test('two stanzas without Path throw, also with a Path stanza between them', () => {
      expect(errorOfParse(stanza('MASS', '1.0') + '\n' + stanza('MASS', '1.1'), cranUpstream, URL)).toBeInstanceOf(
        CapabilityError,
      );
      const between = [stanza('MASS', '1.0'), pathStanza('MASS', '0.9'), stanza('MASS', '1.1')].join('\n');
      expect(errorOfParse(between, cranUpstream, URL)).toBeInstanceOf(CapabilityError);
    });

    test.each([
      ['an invalid version', pathStanza('MASS', '1.0a')],
      ['an invalid name', pathStanza('1abc', '1.0')],
      ['no Version', 'Package: MASS\nPath: 4.7.0/Recommended\n'],
    ])('a Path stanza with %s throws', (_label, body) => {
      expect(errorOfParse(body, cranUpstream, URL)).toBeInstanceOf(CapabilityError);
    });
  });

  test('a long run of spaces before a lone \\r is parsed in linear time', () => {
    const body = 'Package:' + ' '.repeat(200_000) + '\r' + 'xxxxxxxxxx y\nVersion: 1.0\n';
    const start = performance.now();
    const error = errorOfParse(body, cranUpstream, URL) as CapabilityError;
    expect(performance.now() - start).toBeLessThan(250);
    expect(error).toBeInstanceOf(CapabilityError);
    expect(error.code).toBe('upstream_error');
  });

  test('a Package value with a \\r in the middle throws', () => {
    expect(errorOfParse('Package: ab\rcd\nVersion: 1.0\n', cranUpstream, URL)).toBeInstanceOf(CapabilityError);
  });
});

describe('getPackagesFile', () => {
  test('a memo hit makes no second fetch and reports fromCache', async () => {
    const { fetch, deps } = setup();
    const first = await getPackagesFile(deps, cranUpstream, 'src/contrib/PACKAGES');
    expect(first.response.fromCache).toBe(false);
    expect(first.response.url).toBe(CRAN_PACKAGES_URL);
    expect(first.response.lastModified).toBe('2026-10-22T23:51:28.000Z');
    expect('body' in first.response).toBe(false);
    const second = await getPackagesFile(deps, cranUpstream, 'src/contrib/PACKAGES');
    expect(second.response.fromCache).toBe(true);
    expect(second.versions).toBe(first.versions);
    expect(fetch.calls).toEqual([CRAN_PACKAGES_URL]);
  });

  test('concurrent calls on a cold memo share one fetch and one parse', async () => {
    const { fetch, deps } = setup();
    const [a, b] = await Promise.all([
      getPackagesFile(deps, cranUpstream, 'src/contrib/PACKAGES'),
      getPackagesFile(deps, cranUpstream, 'src/contrib/PACKAGES'),
    ]);
    expect(fetch.calls).toEqual([CRAN_PACKAGES_URL]);
    expect(b.versions).toBe(a.versions);
    expect(b.response.fromCache).toBe(true);
  });

  test('a failed load is shared by concurrent callers but not cached', async () => {
    const routes: Record<string, FixtureRoute> = { [CRAN_PACKAGES_URL]: { status: 500, body: 'oops' } };
    const { fetch, deps } = setup(routes);
    const results = await Promise.allSettled([
      getPackagesFile(deps, cranUpstream, 'src/contrib/PACKAGES'),
      getPackagesFile(deps, cranUpstream, 'src/contrib/PACKAGES'),
    ]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(fetch.calls).toHaveLength(1);
  });

  test('a load that never settles fails owner and joiner with upstream_timeout, and is not cached', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { fetch, deps } = setup();
      const calls: string[] = [];
      deps.fetch = ((request: Request) => {
        calls.push(request.url);
        return calls.length === 1 ? new Promise<Response>(() => {}) : fetch(request);
      }) as Deps['fetch'];
      const owner = errorOf(getPackagesFile(deps, cranUpstream, 'src/contrib/PACKAGES'));
      const joiner = errorOf(getPackagesFile(deps, cranUpstream, 'src/contrib/PACKAGES'));
      await vi.advanceTimersByTimeAsync(60_000);
      expect([(await owner).code, (await joiner).code]).toEqual(['upstream_timeout', 'upstream_timeout']);
      expect((await getPackagesFile(deps, cranUpstream, 'src/contrib/PACKAGES')).versions.size).toBe(186);
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('the memo is isolated between two caches', async () => {
    const { fetch, deps } = setup();
    await getPackagesFile(deps, cranUpstream, 'src/contrib/PACKAGES');
    await getPackagesFile({ ...deps, cache: createMemoryCache(deps.now) }, cranUpstream, 'src/contrib/PACKAGES');
    expect(fetch.calls).toEqual([CRAN_PACKAGES_URL, CRAN_PACKAGES_URL]);
  });

  test('the memo expires at fetchedAt + TTL', async () => {
    const { fetch, deps, clock } = setup();
    await getPackagesFile(deps, cranUpstream, 'src/contrib/PACKAGES');
    clock.ms += 3600 * 1000 - 1;
    await getPackagesFile(deps, cranUpstream, 'src/contrib/PACKAGES');
    expect(fetch.calls).toHaveLength(1);
    clock.ms += 1;
    const refreshed = await getPackagesFile(deps, cranUpstream, 'src/contrib/PACKAGES');
    expect(fetch.calls).toHaveLength(2);
    expect(refreshed.response.fromCache).toBe(false);
  });

  test('a 404 is upstream_error saying there is no PACKAGES file', async () => {
    const { deps } = setup({ [CRAN_PACKAGES_URL]: { status: 404, body: 'nope' } });
    const error = await errorOf(getPackagesFile(deps, cranUpstream, 'src/contrib/PACKAGES'));
    expect(error.code).toBe('upstream_error');
    expect(error.message).toBe(`CRAN has no PACKAGES file at ${CRAN_PACKAGES_URL}`);
    expect(error.details).toEqual({ upstream: 'cran', url: CRAN_PACKAGES_URL });
  });

  test('a list with no packages is upstream_error unless allowEmpty', async () => {
    for (const body of ['', '\n\n  \n']) {
      const { deps } = setup({ [CRAN_PACKAGES_URL]: { status: 200, body } });
      const error = await errorOf(getPackagesFile(deps, cranUpstream, 'src/contrib/PACKAGES'));
      expect(error.code).toBe('upstream_error');
      expect(error.message).toBe(`CRAN returned a PACKAGES file with no packages (${CRAN_PACKAGES_URL})`);
      expect(error.details).toEqual({ upstream: 'cran', url: CRAN_PACKAGES_URL });
      const file = await getPackagesFile(deps, cranUpstream, 'src/contrib/PACKAGES', { allowEmpty: true });
      expect(file.versions.size).toBe(0);
    }
  });

  test('one memo entry answers callers that differ in allowEmpty', async () => {
    const { fetch, deps } = setup({ [CRAN_PACKAGES_URL]: { status: 200, body: '' } });
    const lenient = await getPackagesFile(deps, cranUpstream, 'src/contrib/PACKAGES', { allowEmpty: true });
    expect(lenient.versions.size).toBe(0);
    expect((await errorOf(getPackagesFile(deps, cranUpstream, 'src/contrib/PACKAGES'))).code).toBe('upstream_error');
    expect(fetch.calls).toHaveLength(1);
  });

  test.each([{}, { allowEmpty: true }])('a stanza without Package is "unexpected format" (%j)', async (options) => {
    const { deps } = setup({ [CRAN_PACKAGES_URL]: { status: 200, body: 'Version: 1\n' } });
    const error = await errorOf(getPackagesFile(deps, cranUpstream, 'src/contrib/PACKAGES', options));
    expect(error.code).toBe('upstream_error');
    expect(error.message).toBe(`CRAN returned a PACKAGES file in an unexpected format (${CRAN_PACKAGES_URL})`);
  });

  test('a 500 is not memoized', async () => {
    const routes: Record<string, FixtureRoute> = { [CRAN_PACKAGES_URL]: { status: 500, body: 'oops' } };
    const { fetch, deps } = setup(routes);
    expect((await errorOf(getPackagesFile(deps, cranUpstream, 'src/contrib/PACKAGES'))).code).toBe('upstream_error');
    routes[CRAN_PACKAGES_URL] = depsRoutes[CRAN_PACKAGES_URL]!;
    const list = await getPackagesFile(deps, cranUpstream, 'src/contrib/PACKAGES');
    expect(list.versions.size).toBe(186);
    expect(fetch.calls).toHaveLength(2);
  });
});
