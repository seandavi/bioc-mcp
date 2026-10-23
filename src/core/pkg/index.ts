import { bioconductorUpstream } from '../../upstreams/bioconductor';
import { cranUpstream } from '../../upstreams/cran';
import { rUniverseUpstreams } from '../../upstreams/r-universe';
import { registryUpstream } from '../../upstreams/registry';
import type { Module } from '../capability';
import { pkgBuildEnvironment } from './build-environment';
import { pkgCheckOutput } from './check-output';
import { pkgDownloads } from './downloads';
import { pkgMissingDeps } from './missing-deps';
import { triageFailingPackagePrompt } from './prompts';
import { pkgReleaseInfo } from './release-info';
import { pkgRepoDiff } from './repo-diff';
import { pkgRevdeps } from './revdeps';
import { pkgStatus } from './status';

export const pkgModule: Module = {
  name: 'pkg',
  description:
    'Package build and propagation state (Bioconductor registry, r-universe), check output and build ' +
    'environments of r-universe jobs, reverse dependencies and unresolvable dependencies in the propagation ' +
    "index (with CRAN), release versions and download stats (bioconductor.org), and how the registry's index " +
    "compares with bioconductor.org's repositories.",
  upstreams: [
    registryUpstream,
    rUniverseUpstreams.bioc,
    rUniverseUpstreams['bioc-release'],
    bioconductorUpstream,
    cranUpstream,
  ],
  capabilities: [
    pkgStatus,
    pkgCheckOutput,
    pkgBuildEnvironment,
    pkgReleaseInfo,
    pkgDownloads,
    pkgRepoDiff,
    pkgRevdeps,
    pkgMissingDeps,
  ],
  prompts: [triageFailingPackagePrompt],
};
