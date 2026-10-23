import type { Universe } from '../../src/upstreams/registry';
import type { FixtureRoute } from './fixture-fetch';

export const BIOC_INDEX_URL = 'https://bioc-registry.seandavi.workers.dev/data/prop/bioc/index.json';
export const RELEASE_INDEX_URL = 'https://bioc-registry.seandavi.workers.dev/data/prop/bioc-release/index.json';

export function checksUrl(universe: Universe, job: string): string {
  return `https://bioc-registry.seandavi.workers.dev/checks/${universe}/${job}`;
}

export function buildsUrl(universe: Universe, job: string): string {
  return `https://bioc-registry.seandavi.workers.dev/builds/${universe}/${job}`;
}

export function ruUrl(universe: Universe, name: string): string {
  return `https://${universe}.r-universe.dev/api/packages/${name}`;
}

const recorded = (name: string): FixtureRoute => ({
  file: `r-universe/bioc/${name}.json`,
  headers: name === 'trackViewer' ? { 'last-modified': 'Thu, 22 Oct 2026 12:19:43 GMT' } : {},
});
const notFound = (name: string): FixtureRoute => ({
  status: 404,
  body: `Error: Package ${name} not found in bioc`,
});

const CHECKS_NOT_CAPTURED: FixtureRoute = {
  status: 404,
  headers: { 'content-type': 'application/json' },
  body: '{"error":"not captured","detail":"capture walks forward from when it was switched on; artifacts expire upstream at ~100 days","job":"https://github.com/r-universe/bioc/runs/112702240220"}',
};
const BUILDS_NOT_CAPTURED: FixtureRoute = {
  status: 404,
  headers: { 'content-type': 'application/json' },
  body: '{"error":"not captured","detail":"derived from the job log, so it exists only where /logs does","log":"/logs/bioc/112702240220"}',
};

export const pkgRoutes: Record<string, FixtureRoute> = {
  [BIOC_INDEX_URL]: { file: 'registry/prop/bioc/index.json' },
  [RELEASE_INDEX_URL]: { file: 'registry/prop/bioc-release/index.json' },
  ...Object.fromEntries(
    ['trackViewer', 'Chromatograms', 'RMassBank', 'biomaRt', 'ClustIRR', 'SEMPLR', 'BiocSet', 'GEOfastq'].map((name) => [
      ruUrl('bioc', name),
      recorded(name),
    ]),
  ),
  [ruUrl('bioc-release', 'edgeR')]: { file: 'r-universe/bioc-release/edgeR.json' },
  [ruUrl('bioc', 'Fletcher2013a')]: notFound('Fletcher2013a'),
  [ruUrl('bioc', 'edgr')]: notFound('edgr'),
  [ruUrl('bioc', 'biomart')]: notFound('biomart'),
  ...Object.fromEntries(
    // yarn (failing), ADAPT (passing, CRLF), GeneGA (severity budget), singIST (huge ERROR, trimmed),
    // stJoincount (tail and paging), DeepTarget (bioc-checks, no 00check.log),
    // GEOfastq (devel test failure, triage walk)
    ['96299707840', '91456856197', '91651624908', '95858209718', '91484882071', '91902836490', '107579662259'].map((job) => [
      checksUrl('bioc', job),
      { file: `registry/checks/bioc/${job}.json`, headers: { 'content-type': 'application/json' } } as FixtureRoute,
    ]),
  ),
  [checksUrl('bioc-release', '91650205691')]: {
    file: 'registry/checks/bioc-release/91650205691.json',
    headers: { 'content-type': 'application/json' },
  },
  [checksUrl('bioc', '112702240220')]: CHECKS_NOT_CAPTURED, // Chromatograms' current failing source job
  [checksUrl('bioc', '91650205691')]: CHECKS_NOT_CAPTURED, // the release job asked under the wrong universe
  ...Object.fromEntries(
    ['96299707840', '95292180484'].map((job) => [
      buildsUrl('bioc', job),
      { file: `registry/builds/bioc/${job}.json`, headers: { 'content-type': 'application/json' } } as FixtureRoute,
    ]),
  ),
  [buildsUrl('bioc-release', '91650205691')]: {
    file: 'registry/builds/bioc-release/91650205691.json',
    headers: { 'content-type': 'application/json' },
  },
  [buildsUrl('bioc', '112702240220')]: BUILDS_NOT_CAPTURED,
};
