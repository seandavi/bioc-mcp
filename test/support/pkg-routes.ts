import type { Universe } from '../../src/upstreams/registry';
import type { FixtureRoute } from './fixture-fetch';

export const BIOC_INDEX_URL = 'https://bioc-registry.seandavi.workers.dev/data/prop/bioc/index.json';
export const RELEASE_INDEX_URL = 'https://bioc-registry.seandavi.workers.dev/data/prop/bioc-release/index.json';

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

export const pkgRoutes: Record<string, FixtureRoute> = {
  [BIOC_INDEX_URL]: { file: 'registry/prop/bioc/index.json' },
  [RELEASE_INDEX_URL]: { file: 'registry/prop/bioc-release/index.json' },
  ...Object.fromEntries(
    ['trackViewer', 'Chromatograms', 'RMassBank', 'biomaRt', 'ClustIRR', 'SEMPLR', 'BiocSet'].map((name) => [
      ruUrl('bioc', name),
      recorded(name),
    ]),
  ),
  [ruUrl('bioc-release', 'edgeR')]: { file: 'r-universe/bioc-release/edgeR.json' },
  [ruUrl('bioc', 'Fletcher2013a')]: notFound('Fletcher2013a'),
  [ruUrl('bioc', 'edgr')]: notFound('edgr'),
  [ruUrl('bioc', 'biomart')]: notFound('biomart'),
};
