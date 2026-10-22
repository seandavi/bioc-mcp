import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATS_CATEGORIES, type StatsCategory } from '../../src/upstreams/bioconductor';
import type { FixtureRoute } from './fixture-fetch';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'bioconductor');

/** A recorded file under test/fixtures/bioconductor/. */
export function readBiocFixture(path: string): string {
  return readFileSync(join(FIXTURES_DIR, path), 'utf8');
}

export const CONFIG_URL = 'https://bioconductor.org/config.yaml';
export const MANIFEST_URL = 'https://bioconductor.org/api/v1/manifest/index.json';

export function statsPageUrl(category: StatsCategory, name: string): string {
  return `https://bioconductor.org/packages/stats/${category}/${name}/`;
}

export function statsTabUrl(category: StatsCategory, name: string, year: number): string {
  return `${statsPageUrl(category, name)}${name}_${year}_stats.tab`;
}

export const NOT_FOUND: FixtureRoute = { status: 404, body: 'Not Found', headers: { 'content-type': 'text/html' } };

const F = 'bioconductor/packages/stats';

export const bioconductorRoutes: Record<string, FixtureRoute> = {
  [CONFIG_URL]: { file: 'bioconductor/config.yaml', headers: { 'last-modified': 'Sat, 01 Aug 2026 15:44:12 GMT' } },
  [MANIFEST_URL]: { file: 'bioconductor/api/v1/manifest/index.json' },
  [statsPageUrl('bioc', 'edgeR')]: { file: `${F}/bioc/edgeR/index.html` },
  [statsTabUrl('bioc', 'edgeR', 2025)]: { file: `${F}/bioc/edgeR/edgeR_2025_stats.tab` },
  [statsTabUrl('bioc', 'edgeR', 2026)]: {
    file: `${F}/bioc/edgeR/edgeR_2026_stats.tab`,
    headers: { 'last-modified': 'Thu, 22 Oct 2026 09:48:50 GMT' },
  },
  [statsPageUrl('bioc', 'rnaseqGene')]: NOT_FOUND,
  [statsPageUrl('data-annotation', 'rnaseqGene')]: NOT_FOUND,
  [statsPageUrl('data-experiment', 'rnaseqGene')]: NOT_FOUND,
  [statsPageUrl('workflows', 'rnaseqGene')]: { file: `${F}/workflows/rnaseqGene/index.html` },
  [statsTabUrl('workflows', 'rnaseqGene', 2026)]: { file: `${F}/workflows/rnaseqGene/rnaseqGene_2026_stats.tab` },
  ...Object.fromEntries(STATS_CATEGORIES.map((category) => [statsPageUrl(category, 'edgr'), NOT_FOUND])),
};
