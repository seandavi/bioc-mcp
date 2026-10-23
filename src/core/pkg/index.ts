import { bioconductorUpstream } from '../../upstreams/bioconductor';
import { rUniverseUpstreams } from '../../upstreams/r-universe';
import { registryUpstream } from '../../upstreams/registry';
import type { Module } from '../capability';
import { pkgBuildEnvironment } from './build-environment';
import { pkgCheckOutput } from './check-output';
import { pkgDownloads } from './downloads';
import { pkgReleaseInfo } from './release-info';
import { pkgRepoDiff } from './repo-diff';
import { pkgStatus } from './status';

export const pkgModule: Module = {
  name: 'pkg',
  description:
    'Package build and propagation state (Bioconductor registry, r-universe), check output and build ' +
    'environments of r-universe jobs, release versions and download stats (bioconductor.org), and how the ' +
    "registry's index compares with bioconductor.org's repositories.",
  upstreams: [registryUpstream, rUniverseUpstreams.bioc, rUniverseUpstreams['bioc-release'], bioconductorUpstream],
  capabilities: [pkgStatus, pkgCheckOutput, pkgBuildEnvironment, pkgReleaseInfo, pkgDownloads, pkgRepoDiff],
};
