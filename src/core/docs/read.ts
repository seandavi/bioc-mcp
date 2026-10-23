import * as z from 'zod';
import { CapabilityError } from '../../errors';
import type { DocsIndex } from '../../docs-index/load';
import { DocsSourceKindSchema, type DocsRecord } from '../../docs-index/schema';
import { defineCapability, type Capability } from '../capability';
import { chunkText } from './chunk';
import { docsPages, docsSource, renderPage, renderSection, sectionLabel, type DocsPage, type DocsPages } from './pages';

/** Longest id_or_url that docs_read and the docs-page resource accept. */
export const MAX_DOCS_REFERENCE_LENGTH = 2048;

export const DocsReadInputSchema = z.object({
  id_or_url: z
    .string()
    .min(1)
    .max(MAX_DOCS_REFERENCE_LENGTH)
    .describe(
      'A url from docs_search (with #anchor for one section, without for the whole page), a record id ' +
        "('site:propagation-gate.html#why-the-registry-polls'), or a bioc://docs/ resource URI",
    ),
  cursor: z
    .string()
    .regex(/^\d{1,7}$/, 'cursor must be the next_cursor of a previous docs_read call')
    .optional()
    .describe('next_cursor from the previous call, to read the next part'),
});

export const DocsReadDataSchema = z.object({
  kind: z.enum(['page', 'section']),
  url: z.string().describe('Public URL of the page or section'),
  resource_uri: z.string().describe('bioc://docs/ URI of the page'),
  title: z.string(),
  section: z.string().describe("Section heading; '' for a page"),
  crumbs: z.array(z.string()),
  source: DocsSourceKindSchema,
  repo: z.string().nullable(),
  text: z.string().describe('This part of the Markdown text'),
  offset: z.number().int().nonnegative().describe('Start of this part in the full text, in UTF-16 code units'),
  total_chars: z.number().int().nonnegative().describe('Length of the full text, in UTF-16 code units'),
  next_cursor: z.string().nullable().describe('Pass as cursor to read the next part; null on the last part'),
});

export type DocsTarget =
  | { kind: 'page'; page: DocsPage }
  | { kind: 'section'; page: DocsPage; record: DocsRecord }
  | { kind: 'missing'; page: DocsPage | null; fragment: string | null };

const RESOURCE_PREFIX = 'bioc://docs/';
const SHOWN_LENGTH = 200;
const CLOSE_MATCHES = 5;
const MAX_CLOSE_MATCH_TERMS = 8; // MiniSearch runs one prefix+fuzzy sub-query per term
const MAX_CLOSE_MATCH_TERM_LENGTH = 32;
const URL_NOISE = new Set([
  'https', 'http', 'www', 'com', 'org', 'github', 'githubusercontent', 'raw', 'blob', 'tree', 'main',
  'seandavi', 'html', 'htm', 'bioc', 'infrastructure', 'docs', 'site', 'repo',
]);

function pageFor(pages: DocsPages, base: string): DocsPage | undefined {
  if (base.startsWith(RESOURCE_PREFIX)) return pages.byPath.get(base.slice(RESOURCE_PREFIX.length));
  if (base.startsWith('site:') || base.startsWith('repo:')) return pages.byId.get(base);
  if (base.startsWith('https://')) {
    try {
      return pages.byUrl.get(new URL(base).href);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Resolves only against the index; never fetches. */
export function resolveDocsTarget(pages: DocsPages, input: string): DocsTarget {
  const s = input.trim();
  const hash = s.indexOf('#');
  const base = hash === -1 ? s : s.slice(0, hash);
  const fragment = hash === -1 || hash === s.length - 1 ? null : s.slice(hash + 1);

  const page = pageFor(pages, base);
  if (!page) return { kind: 'missing', page: null, fragment };
  if (fragment === null) return { kind: 'page', page };
  const record = pages.section(page, fragment);
  return record ? { kind: 'section', page, record } : { kind: 'missing', page, fragment };
}

/**
 * The words of `text` worth searching for: lower-case, at least 3 characters, not in `ignore`, distinct, at most
 * MAX_CLOSE_MATCH_TERMS of them, each cut to MAX_CLOSE_MATCH_TERM_LENGTH. Caller text of any length costs one bounded search.
 */
function closeMatchTerms(text: string, ignore: ReadonlySet<string> = new Set()): string[] {
  const terms = new Set<string>();
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length < 3 || ignore.has(word)) continue;
    terms.add(word.slice(0, MAX_CLOSE_MATCH_TERM_LENGTH));
    if (terms.size === MAX_CLOSE_MATCH_TERMS) break;
  }
  return [...terms];
}

/** The not_found error for a missing target, with up to 5 close matches from the index. */
export function docsNotFound(
  index: DocsIndex,
  pages: DocsPages,
  input: string,
  target: Extract<DocsTarget, { kind: 'missing' }>,
): CapabilityError {
  const { page, fragment } = target;
  if (page && fragment !== null) {
    const terms = closeMatchTerms(fragment);
    const found =
      terms.length === 0
        ? []
        : index
            .search(terms.join(' '), CLOSE_MATCHES, (r) => r.id !== page.id && page.records.includes(r))
            .map((hit) => hit.record);
    const sections = found.length > 0 ? found : page.records.filter((r) => r.id !== page.id).slice(0, CLOSE_MATCHES);
    return new CapabilityError(
      'not_found',
      `No section "#${fragment}" on ${page.url}. Sections on that page include: ${sections.map((r) => r.url).join(', ')}. docs_read reads only the docs index and never fetches URLs.`,
    );
  }

  const shown = input.length > SHOWN_LENGTH ? input.slice(0, SHOWN_LENGTH) + '…' : input;
  const words = closeMatchTerms(input, URL_NOISE);
  const matches =
    words.length === 0
      ? []
      : [...new Set(index.search(words.join(' '), CLOSE_MATCHES).map((hit) => hit.record.url))];
  return new CapabilityError(
    'not_found',
    `No docs page or section matches "${shown}". docs_read reads only the docs index and never fetches URLs; pass a url from docs_search, a record id or a bioc://docs/ URI.` +
      (matches.length > 0 ? ` Close matches: ${matches.join(', ')}.` : ' Use docs_search to find one.'),
  );
}

export function docsReadCapability(
  getIndex: () => DocsIndex,
): Capability<typeof DocsReadInputSchema, typeof DocsReadDataSchema> {
  return defineCapability({
    module: 'docs',
    name: 'docs_read',
    title: 'Read a docs page or section',
    description:
      'Read the full text of one Bioconductor infrastructure docs page or section, as Markdown with ' +
      'links. Pass a url from docs_search: a url with #anchor reads that section, a url without one reads ' +
      'the whole page. A record id or a bioc://docs/ URI also works. Long text comes in parts: call again ' +
      'with cursor set to next_cursor. Reads only the docs index bundled with this server and never ' +
      'fetches a URL, so a URL that is not in the index returns not_found with close matches. To find a ' +
      'page, use docs_search. For live package state use pkg_status; for open issues, pull requests or ' +
      'failing workflows use ops_activity.',
    input: DocsReadInputSchema,
    data: DocsReadDataSchema,
    async handler({ id_or_url, cursor }) {
      const index = getIndex();
      const pages = docsPages(index);
      const target = resolveDocsTarget(pages, id_or_url);
      if (target.kind === 'missing') throw docsNotFound(index, pages, id_or_url, target);

      const { page } = target;
      const full = target.kind === 'page' ? renderPage(page) : renderSection(target.record);
      const offset = cursor === undefined ? 0 : Number(cursor);
      if (offset > full.length || (offset === full.length && offset > 0)) {
        throw new CapabilityError(
          'invalid_input',
          `cursor ${cursor} is past the end of the text (${full.length} characters); start again without cursor`,
        );
      }
      const { text, end } = chunkText(full, offset);
      const nextCursor = end < full.length ? String(end) : null;

      const source = target.kind === 'page' ? page : target.record;
      const url = target.kind === 'page' ? page.url : target.record.url;
      const section = target.kind === 'page' ? '' : sectionLabel(target.record);
      const label = target.kind === 'page' ? `"${page.title}"` : `"${page.title}" › ${section}`;
      const summary =
        offset === 0 && nextCursor === null
          ? `${label} (${url}), full text, ${full.length} characters.`
          : `${label} (${url}), characters ${offset + 1}–${end} of ${full.length}.` +
            (nextCursor === null ? '' : ` Call docs_read again with cursor "${nextCursor}" for the rest.`);

      return {
        data: {
          kind: target.kind,
          url,
          resource_uri: page.uri,
          title: page.title,
          section,
          crumbs: source.crumbs,
          source: source.source,
          repo: source.repo ?? null,
          text,
          offset,
          total_chars: full.length,
          next_cursor: nextCursor,
        },
        summary,
        sources: [docsSource(page.input)],
      };
    },
  });
}
