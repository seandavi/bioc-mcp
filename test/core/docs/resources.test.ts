import { beforeAll, describe, expect, it } from 'vitest';
import { docsPages, renderPage, renderSection } from '../../../src/core/docs/pages';
import { docsPageResource } from '../../../src/core/docs/resources';
import type { ResourceTemplateDef } from '../../../src/core/capability';
import { CapabilityError } from '../../../src/errors';
import { fixtureDocsIndex } from '../../support/docs';

const BASE = 'https://seandavi.github.io/bioc-infrastructure/';

let resource: ResourceTemplateDef;
beforeAll(async () => {
  const index = await fixtureDocsIndex();
  resource = docsPageResource(() => index);
});

describe('docsPageResource', () => {
  it('is the docs-page template under bioc://docs/', () => {
    expect(resource).toMatchObject({ name: 'docs-page', uriTemplate: 'bioc://docs/{+path}', mimeType: 'text/markdown' });
  });

  it('lists one resource per page', async () => {
    const listing = resource.list();
    expect(listing).toHaveLength(56);
    expect(listing.find((r) => r.uri === 'bioc://docs/propagation-gate.html')).toEqual({
      uri: 'bioc://docs/propagation-gate.html',
      name: 'propagation-gate.html',
      title: expect.any(String),
      description: `${BASE}propagation-gate.html`,
    });
    expect(listing.some((r) => r.name === 'repo/bioc-edge/DATAPLANE.md')).toBe(true);
    expect(listing.some((r) => r.name.startsWith('adr/'))).toBe(true);
  });

  it('reads a whole page and a repo document', async () => {
    const pages = docsPages(await fixtureDocsIndex());
    expect(resource.read('bioc://docs/propagation-gate.html')).toBe(renderPage(pages.byPath.get('propagation-gate.html')!));
    expect(resource.read('bioc://docs/repo/bioc-edge/DATAPLANE.md')).toBe(
      renderPage(pages.byPath.get('repo/bioc-edge/DATAPLANE.md')!),
    );
  });

  it('reads one section when the URI has a fragment', async () => {
    const pages = docsPages(await fixtureDocsIndex());
    const record = pages.byPath.get('propagation-gate.html')!.records.find((r) => r.url.endsWith('#why-the-registry-polls'))!;
    expect(resource.read('bioc://docs/propagation-gate.html#why-the-registry-polls')).toBe(renderSection(record));
  });

  it('throws not_found for an unknown URI, pointing at docs_search', () => {
    expect.assertions(3);
    try {
      resource.read('bioc://docs/nope.html');
    } catch (error) {
      expect(error).toBeInstanceOf(CapabilityError);
      expect((error as CapabilityError).code).toBe('not_found');
      expect((error as CapabilityError).message).toContain('docs_search');
    }
  });
});
