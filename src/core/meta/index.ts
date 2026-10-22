import type { Module } from '../capability';
import { metaPing } from './ping';

export const metaModule: Module = {
  name: 'meta',
  description: 'Server health and version.',
  upstreams: [],
  capabilities: [metaPing],
};
