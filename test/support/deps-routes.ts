import type { Universe } from '../../src/upstreams/registry';
import type { BiocDataRepo } from '../../src/upstreams/bioconductor';
import type { FixtureRoute } from './fixture-fetch';
import { BIOC_INDEX_URL } from './pkg-routes';

export const CRAN_PACKAGES_URL = 'https://cloud.r-project.org/src/contrib/PACKAGES';

export function biocDataUrl(universe: Universe, repo: BiocDataRepo): string {
  return `https://bioconductor.org/packages/${universe === 'bioc' ? 'devel' : 'release'}/${repo}/src/contrib/PACKAGES`;
}

/** Overrides BIOC_INDEX_URL with the trimmed index; never merge it into the pkg_status tests' routes. */
export const depsRoutes: Record<string, FixtureRoute> = {
  [BIOC_INDEX_URL]: { file: 'registry/prop/bioc/index-deps.json' },
  [CRAN_PACKAGES_URL]: {
    file: 'cran/src/contrib/PACKAGES',
    headers: { 'last-modified': 'Thu, 22 Oct 2026 23:51:28 GMT' },
  },
  [biocDataUrl('bioc', 'data/annotation')]: {
    file: 'bioconductor/packages/devel/data/annotation/src/contrib/PACKAGES',
    headers: { 'last-modified': 'Wed, 21 Oct 2026 15:23:33 GMT' },
  },
  [biocDataUrl('bioc', 'data/experiment')]: {
    file: 'bioconductor/packages/devel/data/experiment/src/contrib/PACKAGES',
    headers: { 'last-modified': 'Thu, 22 Oct 2026 21:31:29 GMT' },
  },
};
