import { rUniverseUpstreams } from '../../upstreams/r-universe';
import { registryUpstream } from '../../upstreams/registry';
import type { Module } from '../capability';
import { pkgStatus } from './status';

export const pkgModule: Module = {
  name: 'pkg',
  description: 'Package build and propagation state from the Bioconductor registry and r-universe.',
  upstreams: [registryUpstream, rUniverseUpstreams.bioc, rUniverseUpstreams['bioc-release']],
  capabilities: [pkgStatus],
};
