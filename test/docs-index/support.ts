import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDocsIndex, type DocsIndexArtifact } from '../../scripts/docs-index/build';
import { parseDocsSourcesConfig, type DocsSourcesConfig } from '../../scripts/docs-index/config';
import { fixtureDocsFetch } from '../../scripts/docs-index/fixtures';
import type { FetchFn } from '../../src/core/deps';

export const DOCS_FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures', 'docs');
export const NOW = () => new Date('2026-10-22T00:00:00Z');
export const BUILD_COMMIT = 'test-commit';

export function realConfig(): DocsSourcesConfig {
  return parseDocsSourcesConfig(readFileSync(join(import.meta.dirname, '..', '..', 'docs-sources.yaml'), 'utf8'));
}

export function buildFromFixtures(
  config: DocsSourcesConfig = realConfig(),
  fetch: FetchFn = fixtureDocsFetch(DOCS_FIXTURES_DIR),
): Promise<DocsIndexArtifact> {
  return buildDocsIndex(config, { fetch, now: NOW, buildCommit: BUILD_COMMIT, env: {} });
}

let shared: Promise<DocsIndexArtifact> | undefined;
/** The real config built once over test/fixtures/docs, shared by a test file. */
export function fixtureArtifact(): Promise<DocsIndexArtifact> {
  shared ??= buildFromFixtures();
  return shared;
}
