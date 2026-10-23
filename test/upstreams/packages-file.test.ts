import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { Deps } from '../../src/core/deps';
import { CapabilityError } from '../../src/errors';
import { createMemoryCache } from '../../src/upstreams/cache';
import { cranUpstream } from '../../src/upstreams/cran';
import { getPackageList, parsePackagesFileNames } from '../../src/upstreams/packages-file';
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

describe('parsePackagesFileNames', () => {
  test('the CRAN fixture has 200 Package: lines and 186 distinct names', () => {
    expect(CRAN_FIXTURE.match(/^Package:/gm)).toHaveLength(200);
    expect(parsePackagesFileNames(CRAN_FIXTURE).size).toBe(186);
  });

  test('accepts CRLF line endings', () => {
    expect([...parsePackagesFileNames('Package: a\r\nVersion: 1\r\n\r\nPackage: b\r\nVersion: 2\r\n')]).toEqual(['a', 'b']);
  });

  test('ignores a trailing space after the name', () => {
    expect([...parsePackagesFileNames('Package: abc \nVersion: 1\n')]).toEqual(['abc']);
  });

  test('counts a duplicate stanza once', () => {
    expect([...parsePackagesFileNames('Package: MASS\nVersion: 1\n\nPackage: MASS\nVersion: 2\n')]).toEqual(['MASS']);
  });

  test('ignores Package: not at line start', () => {
    const body = 'Package: real\nDescription: see\n  Package: nested\nDepends: x\n  Package: indented\n';
    expect([...parsePackagesFileNames(body)]).toEqual(['real']);
  });

  test('an empty body gives an empty set', () => {
    expect(parsePackagesFileNames('').size).toBe(0);
  });
});

describe('getPackageList', () => {
  test('a memo hit makes no second fetch and reports fromCache', async () => {
    const { fetch, deps } = setup();
    const first = await getPackageList(deps, cranUpstream, 'src/contrib/PACKAGES');
    expect(first.response.fromCache).toBe(false);
    expect(first.response.url).toBe(CRAN_PACKAGES_URL);
    expect(first.response.lastModified).toBe('2026-10-22T23:51:28.000Z');
    expect('body' in first.response).toBe(false);
    const second = await getPackageList(deps, cranUpstream, 'src/contrib/PACKAGES');
    expect(second.response.fromCache).toBe(true);
    expect(second.names).toBe(first.names);
    expect(fetch.calls).toEqual([CRAN_PACKAGES_URL]);
  });

  test('the memo is isolated between two caches', async () => {
    const { fetch, deps } = setup();
    await getPackageList(deps, cranUpstream, 'src/contrib/PACKAGES');
    await getPackageList({ ...deps, cache: createMemoryCache(deps.now) }, cranUpstream, 'src/contrib/PACKAGES');
    expect(fetch.calls).toEqual([CRAN_PACKAGES_URL, CRAN_PACKAGES_URL]);
  });

  test('the memo expires at fetchedAt + TTL', async () => {
    const { fetch, deps, clock } = setup();
    await getPackageList(deps, cranUpstream, 'src/contrib/PACKAGES');
    clock.ms += 3600 * 1000 - 1;
    await getPackageList(deps, cranUpstream, 'src/contrib/PACKAGES');
    expect(fetch.calls).toHaveLength(1);
    clock.ms += 1;
    const refreshed = await getPackageList(deps, cranUpstream, 'src/contrib/PACKAGES');
    expect(fetch.calls).toHaveLength(2);
    expect(refreshed.response.fromCache).toBe(false);
  });

  test('a 404 is upstream_error saying there is no PACKAGES file', async () => {
    const { deps } = setup({ [CRAN_PACKAGES_URL]: { status: 404, body: 'nope' } });
    const error = await errorOf(getPackageList(deps, cranUpstream, 'src/contrib/PACKAGES'));
    expect(error.code).toBe('upstream_error');
    expect(error.message).toBe(`CRAN has no PACKAGES file at ${CRAN_PACKAGES_URL}`);
    expect(error.details).toEqual({ upstream: 'cran', url: CRAN_PACKAGES_URL });
  });

  test('a list with no packages is upstream_error', async () => {
    const { deps } = setup({ [CRAN_PACKAGES_URL]: { status: 200, body: 'Version: 1\n' } });
    const error = await errorOf(getPackageList(deps, cranUpstream, 'src/contrib/PACKAGES'));
    expect(error.code).toBe('upstream_error');
    expect(error.message).toBe(`CRAN returned a PACKAGES file with no packages (${CRAN_PACKAGES_URL})`);
  });

  test('a 500 is not memoized', async () => {
    const routes: Record<string, FixtureRoute> = { [CRAN_PACKAGES_URL]: { status: 500, body: 'oops' } };
    const { fetch, deps } = setup(routes);
    expect((await errorOf(getPackageList(deps, cranUpstream, 'src/contrib/PACKAGES'))).code).toBe('upstream_error');
    routes[CRAN_PACKAGES_URL] = depsRoutes[CRAN_PACKAGES_URL]!;
    const list = await getPackageList(deps, cranUpstream, 'src/contrib/PACKAGES');
    expect(list.names.size).toBe(186);
    expect(fetch.calls).toHaveLength(2);
  });
});
