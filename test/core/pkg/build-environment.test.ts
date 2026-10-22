import { describe, expect, test } from 'vitest';
import type * as z from 'zod';
import { invokeCapability } from '../../../src/core/invoke';
import { pkgBuildEnvironment, PkgBuildEnvironmentDataSchema } from '../../../src/core/pkg/build-environment';
import { envelopeBytes, MAX_RESULT_BYTES, type Envelope } from '../../../src/envelope';
import { createMemoryCache } from '../../../src/upstreams/cache';
import { fixtureFetch, type FixtureRoute } from '../../support/fixture-fetch';
import { buildsUrl, pkgRoutes } from '../../support/pkg-routes';

type Data = z.output<typeof PkgBuildEnvironmentDataSchema>;
type Input = { universe: string; job: string; dependencies?: string[] };

const NOW = '2026-10-22T12:00:00.000Z';

async function run(input: Input, routes: Record<string, FixtureRoute> = pkgRoutes) {
  const fetch = fixtureFetch(routes);
  const now = () => new Date(NOW);
  const result = await invokeCapability(pkgBuildEnvironment, input, {
    fetch,
    cache: createMemoryCache(now),
    now,
    env: {},
  });
  return { result, fetch };
}

async function buildEnvironment(input: Input, routes?: Record<string, FixtureRoute>) {
  const { result, fetch } = await run(input, routes);
  if (!result.ok) throw result.error;
  const envelope = result.envelope as Envelope<Data>;
  expect(envelopeBytes(envelope)).toBeLessThan(MAX_RESULT_BYTES);
  return { envelope, data: envelope.data, summary: envelope.summary, fetch };
}

describe('container build (yarn)', () => {
  test('image digest, repos and the named dependency versions', async () => {
    const { data, summary, envelope, fetch } = await buildEnvironment({
      universe: 'bioc',
      job: '96299707840',
      dependencies: ['biomaRt', 'httr2'],
    });
    expect(data.image).toMatch(/^ghcr\.io\/r-universe-org\/base-image@sha256:5cb77d52/);
    expect(data.digest).toMatch(/^sha256:5cb77d52/);
    expect(data.digest).toHaveLength('sha256:'.length + 64);
    expect(data.repos).toEqual(['https://bioc.r-universe.dev', 'https://cran.r-universe.dev']);
    expect(data.moving_repos).toEqual([]);
    expect(data.deps_count).toBe(174);
    expect(data.deps).toEqual([
      { package: 'biomaRt', version: '2.69.0' },
      { package: 'httr2', version: '1.3.0' },
    ]);
    expect(data.job_url).toBe('https://github.com/r-universe/bioc/runs/96299707840');
    expect(summary).toContain('ran in container ghcr.io/r-universe-org/base-image@sha256:5cb77d52');
    expect(summary).toContain('It installed 174 dependencies from 2 repositories.');
    expect(summary).toContain('Versions: biomaRt 2.69.0, httr2 1.3.0.');
    expect(envelope.sources).toEqual([{ url: buildsUrl('bioc', '96299707840'), as_of: NOW }]);
    expect(fetch.calls).toEqual([buildsUrl('bioc', '96299707840')]);
  });

  test('without dependencies it says how to see versions', async () => {
    const { data, summary } = await buildEnvironment({ universe: 'bioc', job: '96299707840' });
    expect(data.deps).toEqual([]);
    expect(summary).toContain('Pass dependencies to see installed versions.');
  });

  test('unknown names get version null, duplicates are dropped, request order is kept', async () => {
    const { data, summary } = await buildEnvironment({
      universe: 'bioc',
      job: '96299707840',
      dependencies: ['httr2', 'notAPackage', 'biomaRt', 'httr2', 'constructor', 'toString'],
    });
    expect(data.deps).toEqual([
      { package: 'httr2', version: '1.3.0' },
      { package: 'notAPackage', version: null },
      { package: 'biomaRt', version: '2.69.0' },
      { package: 'constructor', version: null },
      { package: 'toString', version: null },
    ]);
    expect(summary).toContain('notAPackage not installed');
  });
});

describe('runner build (scGraphVerse, largest)', () => {
  test('no digest, 380 dependencies, and the dependency list is not in the envelope', async () => {
    const { data, summary, envelope } = await buildEnvironment({ universe: 'bioc', job: '95292180484' });
    expect(data.image).toBe('macos-15-arm64@20260727.0256.1');
    expect(data.digest).toBeNull();
    expect(data.deps_count).toBe(380);
    expect(data.repos).toHaveLength(4);
    expect(summary).toContain('ran on runner image macos-15-arm64@20260727.0256.1 (no container digest).');
    expect(JSON.stringify(envelope)).not.toContain('"Rhtslib"');
  });
});

describe('moving repository (bioc-release)', () => {
  test('lists the p3m latest repo and says so in the summary', async () => {
    const { data, summary } = await buildEnvironment({
      universe: 'bioc-release',
      job: '91650205691',
      dependencies: ['shiny'],
    });
    expect(data.moving_repos).toEqual(['https://p3m.dev/all/__linux__/resolute/latest']);
    expect(data.deps_count).toBe(274);
    expect(data.deps).toEqual([{ package: 'shiny', version: '1.14.0' }]);
    expect(summary).toContain(
      'https://p3m.dev/all/__linux__/resolute/latest is a moving snapshot; the dependency versions are the record of what it served.',
    );
  });
});

describe('summary for other manifests', () => {
  const run = (manifest: unknown, dependencies?: string[]) =>
    buildEnvironment(
      { universe: 'bioc', job: '5', ...(dependencies ? { dependencies } : {}) },
      { [buildsUrl('bioc', '5')]: { status: 200, body: JSON.stringify(manifest) } },
    );

  test('a manifest with no image, repos or deps', async () => {
    const { data, summary } = await run({});
    expect(data).toMatchObject({ image: null, digest: null, repos: [], moving_repos: [], deps_count: 0, deps: [] });
    expect(summary).toBe('bioc job 5: the build manifest records no image. It installed 0 dependencies from 0 repositories.');
  });

  test('null fields behave like absent ones', async () => {
    const { data } = await run({ image: null, repos: null, deps: null });
    expect(data.deps_count).toBe(0);
  });

  test('several moving repos, and more than ten requested versions', async () => {
    const deps = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`pkg${i}`, `1.${i}`]));
    const { summary, data } = await run(
      { image: 'windows-2025-vs2026@20260101.1', repos: ['https://p3m.dev/cran/latest/', 'https://x.test/a/latest', 'https://y.test/'], deps },
      Object.keys(deps),
    );
    expect(data.moving_repos).toEqual(['https://p3m.dev/cran/latest/', 'https://x.test/a/latest']);
    expect(summary).toContain('are moving snapshots;');
    expect(summary).toContain('pkg9 1.9 and 2 more.');
  });
});

describe('errors', () => {
  test('a job without a manifest is not_found and says build manifest', async () => {
    const { result } = await run({ universe: 'bioc', job: '112702240220' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not_found');
    expect(result.error.message).toContain('build manifest');
    expect(result.error.message).toContain('https://github.com/r-universe/bioc/runs/112702240220');
  });

  test('more than 50 dependencies, or an invalid name, is invalid_input without a fetch', async () => {
    for (const dependencies of [Array.from({ length: 51 }, (_, i) => `pkg${i}`), ['a/b']]) {
      const { result, fetch } = await run({ universe: 'bioc', job: '96299707840', dependencies });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid_input');
      expect(fetch.calls).toEqual([]);
    }
  });
});
