import { describe, expect, test } from 'vitest';
import { invokeCapability } from '../../../src/core/invoke';
import { parseReleaseDate, pkgReleaseInfo, PkgReleaseInfoDataSchema } from '../../../src/core/pkg/release-info';
import { envelopeBytes, MAX_RESULT_BYTES, type Envelope } from '../../../src/envelope';
import { createMemoryCache } from '../../../src/upstreams/cache';
import { bioconductorRoutes, CONFIG_URL, MANIFEST_URL, readBiocFixture } from '../../support/bioconductor-routes';
import { fixtureFetch, type FixtureRoute } from '../../support/fixture-fetch';
import * as z from 'zod';
import { testContext } from '../../support/invoke-context';

type Data = z.output<typeof PkgReleaseInfoDataSchema>;

const NOW = '2026-10-22T12:00:00.000Z';
const manifestFixture = JSON.parse(readBiocFixture('api/v1/manifest/index.json')) as Record<string, any>;

/** The recorded manifest index with `change` applied, as an inline route. */
function manifestRoute(change: (index: Record<string, any>) => void): Record<string, FixtureRoute> {
  const index = structuredClone(manifestFixture);
  change(index);
  return { [MANIFEST_URL]: { status: 200, body: JSON.stringify(index) } };
}

async function run(extra: Record<string, FixtureRoute> = {}) {
  const fetch = fixtureFetch({ ...bioconductorRoutes, ...extra });
  const now = () => new Date(NOW);
  const result = await invokeCapability(pkgReleaseInfo, {}, { fetch, cache: createMemoryCache(now), now, env: {} }, testContext());
  return { result, fetch };
}

async function info(extra: Record<string, FixtureRoute> = {}) {
  const { result } = await run(extra);
  if (!result.ok) throw result.error;
  const envelope = result.envelope as Envelope<Data>;
  return { envelope, data: envelope.data };
}

describe('parseReleaseDate', () => {
  test.each([
    ['04/29/2026', '2026-04-29'],
    ['1/5/2001', '2001-01-05'],
    ['13/01/2026', null],
    ['2/30/2026', null],
    ['2026-04-29', null],
    ['', null],
    [undefined, null],
  ])('%s', (value, expected) => {
    expect(parseReleaseDate(value)).toBe(expected);
  });
});

describe('pkg_release_info', () => {
  test('the sources agree', async () => {
    const { envelope, data } = await info();
    expect(data.release).toEqual({ version: '3.23', r_version: '4.6.0', release_date: '2026-04-29' });
    expect(data.devel).toEqual({ version: '3.24', r_version: '4.6.0', release_date: null });
    expect(data.agree).toBe(true);
    expect(data.disagreements).toEqual([]);
    expect(data.manifest.serving_symlinks).toEqual({ release: '3.23', devel: '3.24' });
    expect(data.manifest.generated).toBe('2026-10-22T17:45:18Z');
    expect(data.manifest.manifests).toHaveLength(10);
    expect(data.manifest.manifests[0]).toEqual({
      path: '3.23/bioc.tsv.gz',
      url: 'https://bioconductor.org/api/v1/manifest/3.23/bioc.tsv.gz',
      objects: 30037,
      without_hash: 0,
    });
    expect(envelope.sources).toEqual([
      { url: CONFIG_URL, as_of: '2026-08-01T15:44:12.000Z' },
      { url: MANIFEST_URL, as_of: '2026-10-22T17:45:18Z' },
    ]);
    expect(envelope.summary).toBe(
      'Bioconductor 3.23 is the current release (R 4.6.0, released 2026-04-29); 3.24 is devel (R 4.6.0). ' +
        'config.yaml and the manifest index (generated 2026-10-22T17:45:18Z) agree.',
    );
    expect(envelopeBytes(envelope)).toBeLessThan(MAX_RESULT_BYTES);
  });

  test('agree and manifest.build are described', () => {
    expect(PkgReleaseInfoDataSchema.shape.agree.description).toContain('packages/release and packages/devel symlinks');
    const json = z.toJSONSchema(PkgReleaseInfoDataSchema) as unknown as {
      properties: { manifest: { properties: { build: { description?: string } } } };
    };
    expect(json.properties.manifest.properties.build.description).toBeTruthy();
  });

  test('the versions disagree', async () => {
    const { envelope, data } = await info(manifestRoute((index) => (index.versions.release = '3.22')));
    expect(data.agree).toBe(false);
    expect(data.disagreements).toEqual([
      'config.yaml says release 3.23; the manifest index says 3.22.',
      'The packages/release symlink points to 3.23; the manifest index says release 3.22.',
    ]);
    expect(envelope.summary).toContain('The sources disagree: config.yaml says release 3.23;');
  });

  test('only a symlink disagrees', async () => {
    const { envelope, data } = await info(manifestRoute((index) => (index.symlinks['packages/devel'] = '3.23')));
    expect(data.agree).toBe(false);
    expect(data.disagreements).toEqual([
      'The packages/devel symlink points to 3.23; the manifest index says devel 3.24.',
    ]);
    expect(envelope.summary).toContain('The sources disagree:');
  });

  test('a devel mismatch comes before the symlink checks', async () => {
    const { data } = await info(manifestRoute((index) => (index.versions.devel = '3.25')));
    expect(data.disagreements[0]).toBe('config.yaml says devel 3.24; the manifest index says 3.25.');
    expect(data.disagreements[1]).toBe('The packages/devel symlink points to 3.24; the manifest index says devel 3.25.');
  });

  test('a manifest without symlinks or build still succeeds', async () => {
    const { data } = await info(
      manifestRoute((index) => {
        delete index.symlinks;
        delete index.build;
      }),
    );
    expect(data.manifest.serving_symlinks).toEqual({ release: null, devel: null });
    expect(data.manifest.build).toBeNull();
    expect(data.agree).toBe(true);
  });

  test('a foreign manifest_prefix gives url null for every manifest', async () => {
    const { data } = await info(manifestRoute((index) => (index.manifest_prefix = '/other')));
    expect(data.manifest.manifests.map((m) => m.url)).toEqual(Array(10).fill(null));
  });

  test('a path that climbs out gives url null', async () => {
    const { data } = await info(manifestRoute((index) => (index.manifests[0].path = '../x.tsv.gz')));
    expect(data.manifest.manifests[0]!.url).toBeNull();
    expect(data.manifest.manifests[1]!.url).not.toBeNull();
  });

  test('invalid YAML is upstream_error', async () => {
    const { result } = await run({ [CONFIG_URL]: { status: 200, body: 'a: [unclosed\n' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('upstream_error');
  });

  test('config.yaml without release_version is upstream_error', async () => {
    const { result } = await run({ [CONFIG_URL]: { status: 200, body: 'devel_version: "3.24"\n' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('upstream_error');
  });

  test('a manifest of the wrong shape is upstream_error', async () => {
    const { result } = await run({ [MANIFEST_URL]: { status: 200, body: '{"generated": 1}' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('upstream_error');
  });

  test.each([CONFIG_URL, MANIFEST_URL])('a 500 from %s fails the whole call', async (url) => {
    const { result } = await run({ [url]: { status: 500 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('upstream_error');
  });
});
