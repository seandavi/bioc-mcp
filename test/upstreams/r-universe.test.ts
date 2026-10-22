import { describe, expect, test } from 'vitest';
import type { Deps } from '../../src/core/deps';
import { CapabilityError } from '../../src/errors';
import { createMemoryCache } from '../../src/upstreams/cache';
import { getUniversePackage } from '../../src/upstreams/r-universe';
import { fixtureFetch, type FixtureRoute } from '../support/fixture-fetch';
import { pkgRoutes, ruUrl } from '../support/pkg-routes';

function makeDeps(routes: Record<string, FixtureRoute> = pkgRoutes): Deps {
  const now = () => new Date('2026-10-22T12:00:00Z');
  return { fetch: fixtureFetch(routes), cache: createMemoryCache(now), now, env: {} };
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

describe('getUniversePackage', () => {
  test('returns the validated record and the response', async () => {
    const result = await getUniversePackage(makeDeps(), 'bioc', 'trackViewer');
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.record).toMatchObject({ Package: 'trackViewer', Version: '1.49.3', _status: 'success' });
    expect(result.response.url).toBe(ruUrl('bioc', 'trackViewer'));
  });

  test('a 404 is { found: false } with the URL asked and the test clock', async () => {
    const result = await getUniversePackage(makeDeps(), 'bioc', 'edgr');
    expect(result).toEqual({
      found: false,
      source: { url: ruUrl('bioc', 'edgr'), as_of: '2026-10-22T12:00:00.000Z' },
    });
  });

  test('a 500 is upstream_error', async () => {
    const deps = makeDeps({ [ruUrl('bioc', 'trackViewer')]: { status: 500 } });
    expect(await codeOf(getUniversePackage(deps, 'bioc', 'trackViewer'))).toBe('upstream_error');
  });

  test('a record for a different Package is upstream_error', async () => {
    const deps = makeDeps({ [ruUrl('bioc', 'trackViewer')]: { file: 'r-universe/bioc/SEMPLR.json' } });
    expect(await codeOf(getUniversePackage(deps, 'bioc', 'trackViewer'))).toBe('upstream_error');
  });

  test('a record with the wrong shape is upstream_error', async () => {
    const deps = makeDeps({ [ruUrl('bioc', 'trackViewer')]: { status: 200, body: '{"Package":"trackViewer"}' } });
    expect(await codeOf(getUniversePackage(deps, 'bioc', 'trackViewer'))).toBe('upstream_error');
  });
});
