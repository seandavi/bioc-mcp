import { githubUpstream } from '../../upstreams/github';
import type { Module } from '../capability';
import { opsActivity } from './activity';

export const opsModule: Module = {
  name: 'ops',
  description: 'Issues, pull requests and GitHub Actions state across the seandavi/bioc-* infrastructure repos.',
  upstreams: [githubUpstream],
  capabilities: [opsActivity],
};
