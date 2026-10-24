import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BbsBuild, BbsReport } from '../../src/upstreams/bbs';
import type { FixtureRoute } from './fixture-fetch';
import { BIOC_INDEX_URL } from './pkg-routes';

export const BBS_BASE = 'https://bioconductor.org/checkResults/';

const CHECK_RESULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'bioconductor', 'checkResults');

/** The URL of `rest` in a BBS report build, e.g. bbsUrl('devel', 'bioc', 'BUILD_STATUS_DB.txt'). */
export function bbsUrl(report: BbsReport, build: BbsBuild, rest: string): string {
  return `${BBS_BASE}${report}/${build}-LATEST/${rest}`;
}

// Recorded 2026-10-24: each recorded URL → the last-modified header it came with.
const lastModified = JSON.parse(readFileSync(join(CHECK_RESULTS_DIR, 'last-modified.json'), 'utf8')) as Record<
  string,
  string
>;

export const bbsRoutes: Record<string, FixtureRoute> = Object.fromEntries(
  Object.entries(lastModified).map(([url, modified]) => [
    url,
    { file: `bioconductor/checkResults/${url.slice(BBS_BASE.length)}`, headers: { 'last-modified': modified } } as FixtureRoute,
  ]),
);

/** Replaces the devel index with the 2026-10-24 one (Chromatograms and affxparser only); merge it after bbsRoutes. */
export const liveIndexRoutes: Record<string, FixtureRoute> = {
  [BIOC_INDEX_URL]: { file: 'registry/prop/bioc/index-2026-10-24.json' },
};
