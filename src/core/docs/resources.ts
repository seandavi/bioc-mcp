import { CapabilityError } from '../../errors';
import type { DocsIndex } from '../../docs-index/load';
import type { ResourceTemplateDef } from '../capability';
import { docsPages, renderPage, renderSection } from './pages';
import { MAX_DOCS_REFERENCE_LENGTH, docsNotFound, resolveDocsTarget } from './read';

export function docsPageResource(getIndex: () => DocsIndex): ResourceTemplateDef {
  return {
    name: 'docs-page',
    uriTemplate: 'bioc://docs/{+path}',
    title: 'Docs page',
    description:
      'One page of the Bioconductor infrastructure docs (a site page, an ADR, or a bioc-* repo document) as Markdown, whole. ' +
      'Paths: <page>.html, adr/<adr>.html, repo/<repo>/<file>.md. For a part of a page, or over REST, use docs_read.',
    mimeType: 'text/markdown',
    list() {
      return docsPages(getIndex()).list.map((page) => ({
        uri: page.uri,
        name: page.path,
        title: page.title,
        description: page.url,
      }));
    },
    // Returns the whole page: AGENTS.md's 8 KB limit is for tool results, and a resource is attached deliberately.
    read(uri) {
      if (uri.length > MAX_DOCS_REFERENCE_LENGTH) {
        throw new CapabilityError(
          'not_found',
          `No docs page or section matches this ${uri.length}-character URI; no docs URI is longer than ${MAX_DOCS_REFERENCE_LENGTH} characters. Use docs_search to find one.`,
        );
      }
      const index = getIndex();
      const pages = docsPages(index);
      const target = resolveDocsTarget(pages, uri);
      if (target.kind === 'missing') throw docsNotFound(index, pages, uri, target, 'resource');
      return target.kind === 'page' ? renderPage(target.page) : renderSection(target.record);
    },
  };
}
