import { bundledDocsIndex } from '../../docs-index/bundled';
import type { DocsIndex } from '../../docs-index/load';
import type { Module } from '../capability';
import { ageDays, docsFreshness, inputStaleWarning } from './freshness';
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
    datasets: (now) => {
      const { meta } = getIndex();
      return [
        {
          id: 'docs-index',
          description:
            'Docs index (MiniSearch BM25) built in CI from docs-sources.yaml and bundled with this Worker; docs_search, docs_read and bioc://docs/ read only this. ' +
            'Each input lists its source commit; possibly_stale says why it may be out of date.',
          built_at: meta.built_at,
          build_commit: meta.build_commit,
          age_days: ageDays(meta.built_at, now),
          possibly_stale: docsFreshness(meta, meta.inputs, now).possibly_stale,
          inputs: meta.inputs.map((input) => ({
            ...docsSource(input),
            commit: input.commit && {
              repo: input.commit.repo,
              ref: input.commit.ref,
              sha: input.commit.sha,
              head_sha: input.commit.head_sha,
              head_committed_at: input.commit.head_committed_at,
            },
            possibly_stale: inputStaleWarning(input, now),
          })),
        },
      ];
    },
  };
}

export const docsModule = createDocsModule(bundledDocsIndex);
