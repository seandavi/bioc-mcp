import type { Deps } from '../core/deps';
import type { Upstream } from './http';
import { getPackagesFile, type PackagesFile } from './packages-file';

export const CRAN_BASE_URL = 'https://cloud.r-project.org/';

export const cranUpstream: Upstream = {
  id: 'cran',
  name: 'CRAN',
  baseUrl: CRAN_BASE_URL,
  ttlSeconds: 3600,
  timeoutMs: 20_000, // the PACKAGES file is ~7.4 MB, uncompressed
  maxBytes: 16 * 1024 * 1024, // 7.4 MB on 2026-10-22
  description:
    "CRAN's current source package list (src/contrib/PACKAGES), read for package names only, to tell which " +
    'dependencies of Bioconductor packages are on CRAN.',
};

/** GET src/contrib/PACKAGES on CRAN; an empty file is upstream_error. */
export function getCranPackagesFile(deps: Deps): Promise<PackagesFile> {
  return getPackagesFile(deps, cranUpstream, 'src/contrib/PACKAGES');
}
