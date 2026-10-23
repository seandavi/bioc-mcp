import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DocsSourcesConfigSchema, parseDocsSourcesConfig } from '../../scripts/docs-index/config';

const valid = {
  max_artifact_bytes: 1000,
  site_url: 'https://example.org/docs/',
  site_repo: 'site',
  github_owner: 'seandavi',
  repos: [{ repo: 'a', ref: 'main', files: ['README.md'] }],
};

describe('docs-sources.yaml', () => {
  it('parses the committed config', () => {
    const config = parseDocsSourcesConfig(readFileSync(join(import.meta.dirname, '../../docs-sources.yaml'), 'utf8'));
    expect(config.repos.length).toBeGreaterThan(0);
  });

  it('accepts a minimal config', () => {
    expect(DocsSourcesConfigSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    ['an http: site_url', { ...valid, site_url: 'http://example.org/docs/' }],
    ['a site_url without a trailing slash', { ...valid, site_url: 'https://example.org/docs' }],
    ['a missing site_repo', { ...valid, site_repo: undefined }],
    ['a github_owner other than seandavi', { ...valid, github_owner: 'other' }],
    ['an unknown key', { ...valid, extra: 1 }],
    ['a duplicate repo', { ...valid, repos: [valid.repos[0], valid.repos[0]] }],
    ['a file not ending in .md', { ...valid, repos: [{ repo: 'a', ref: 'main', files: ['notes.txt'] }] }],
    ['empty repos', { ...valid, repos: [] }],
  ])('rejects %s', (_label, config) => {
    expect(DocsSourcesConfigSchema.safeParse(config).success).toBe(false);
  });

  it('prefixes parse errors with the file name', () => {
    expect(() => parseDocsSourcesConfig('max_artifact_bytes: -1')).toThrow(/^docs-sources\.yaml: /);
  });
});
