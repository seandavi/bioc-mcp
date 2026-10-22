import MiniSearch from 'minisearch';
import type { Module } from '../../src/core/registry';
import { createDocsModule } from '../../src/core/docs';
import { loadDocsIndex, type DocsIndex } from '../../src/docs-index/load';
import { DOCS_FORMAT_VERSION, DOCS_INDEX_OPTIONS, type DocsRecord } from '../../src/docs-index/schema';
import { fixtureArtifact } from '../docs-index/support';

let shared: Promise<DocsIndex> | undefined;
/** loadDocsIndex over the shared fixture build (test/docs-index/support.ts fixtureArtifact). */
export function fixtureDocsIndex(): Promise<DocsIndex> {
  shared ??= fixtureArtifact().then(loadDocsIndex);
  return shared;
}

/** A DocsIndex over `records` (one input, https://docs.test/search.json, fetched_at 2026-10-22T00:00:00.000Z): builds the store and a MiniSearch with DOCS_INDEX_OPTIONS in memory. */
export function syntheticDocsIndex(records: DocsRecord[]): DocsIndex {
  const miniSearch = new MiniSearch<DocsRecord>(DOCS_INDEX_OPTIONS);
  miniSearch.addAll(records);
  const store = {
    format_version: DOCS_FORMAT_VERSION,
    meta: {
      built_at: '2026-10-22T00:00:00.000Z',
      build_commit: null,
      record_count: records.length,
      inputs: [
        {
          url: 'https://docs.test/search.json',
          record_count: records.length,
          last_modified: null,
          fetched_at: '2026-10-22T00:00:00.000Z',
          sha256: '0'.repeat(64),
        },
      ],
    },
    records,
  };
  return loadDocsIndex({ storeJson: JSON.stringify(store), indexJson: JSON.stringify(miniSearch) });
}

/** createDocsModule over the fixture index. */
export async function docsTestModule(): Promise<Module> {
  const index = await fixtureDocsIndex();
  return createDocsModule(() => index);
}
