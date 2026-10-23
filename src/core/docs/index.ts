import { bundledDocsIndex } from '../../docs-index/bundled';
import type { DocsIndex } from '../../docs-index/load';
import type { Module } from '../capability';
import { docsSource } from './pages';
import { explainDecisionPrompt } from './prompts';
import { docsReadCapability } from './read';
import { docsPageResource } from './resources';
import { docsSearchCapability } from './search';

/** The docs module over `getIndex` (called on first use, never at import). */
export function createDocsModule(getIndex: () => DocsIndex): Module {
  return {
    name: 'docs',
    description:
      "Search and read the Bioconductor infrastructure docs: the bioc-infrastructure site, its ADRs, and the bioc-* repos' docs.",
    upstreams: [],
    capabilities: [docsSearchCapability(getIndex), docsReadCapability(getIndex)],
    resources: [docsPageResource(getIndex)],
    prompts: [explainDecisionPrompt],
    datasets: () => {
      const { meta } = getIndex();
      return [
        {
          id: 'docs-index',
          description:
            'Docs index (MiniSearch BM25) built in CI from docs-sources.yaml and bundled with this Worker; docs_search, docs_read and bioc://docs/ read only this.',
          built_at: meta.built_at,
          build_commit: meta.build_commit,
          inputs: meta.inputs.map(docsSource),
        },
      ];
    },
  };
}

export const docsModule = createDocsModule(bundledDocsIndex);
