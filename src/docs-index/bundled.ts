import { DOCS_INDEX_JSON, DOCS_STORE_JSON } from '../../generated/docs-index';
import { loadDocsIndex, type DocsIndex } from './load';

let cached: DocsIndex | undefined;

/** The index bundled with this Worker build, loaded once per isolate on first use. */
export function bundledDocsIndex(): DocsIndex {
  cached ??= loadDocsIndex({ storeJson: DOCS_STORE_JSON, indexJson: DOCS_INDEX_JSON });
  return cached;
}
