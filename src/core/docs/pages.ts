import type { Source } from '../../envelope';
import type { DocsIndex } from '../../docs-index/load';
import type { DocsInput, DocsRecord } from '../../docs-index/schema';

type DocsSourceKind = DocsRecord['source'];

export interface DocsPage {
  id: string; // page-level record id: 'site:<href without #>' or 'repo:<repo>/<file>'
  path: string; // resource path: id minus 'site:' for site/adr pages; 'repo/' + id minus 'repo:' for repo docs
  uri: string; // `bioc://docs/${path}`
  url: string; // new URL(record.url) with hash '' → .href
  title: string; // from the page-level record (first record if none)
  crumbs: string[]; // same
  source: DocsSourceKind; // same
  repo: string | null; // same; null unless source === 'repo'
  records: DocsRecord[]; // page-level record first, then the rest in store order
  input: DocsInput; // index.inputFor(records[0].id); every record of a page shares one input
}

export interface DocsPages {
  list: DocsPage[]; // first-appearance order in the store
  byPath: Map<string, DocsPage>;
  byId: Map<string, DocsPage>;
  byUrl: Map<string, DocsPage>; // key: page.url
  /** The record of `page` whose URL hash, without '#', is `fragment` (normalised through URL). */
  section(page: DocsPage, fragment: string): DocsRecord | undefined;
  /** The page `record` belongs to (by page id); undefined for a record not in this index. */
  pageOf(record: DocsRecord): DocsPage | undefined;
}

const cache = new WeakMap<DocsIndex, DocsPages>();

function pageIdOf(record: DocsRecord): string {
  return record.id.split('#')[0]!;
}

function pagePathOf(pageId: string): string {
  return pageId.startsWith('repo:') ? `repo/${pageId.slice('repo:'.length)}` : pageId.slice('site:'.length);
}

function pageUrlOf(record: DocsRecord): string {
  const url = new URL(record.url);
  url.hash = '';
  return url.href;
}

/** Pages of `index`, built once per index (WeakMap cache). Throws Error on a duplicate page path. */
export function docsPages(index: DocsIndex): DocsPages {
  const cached = cache.get(index);
  if (cached) return cached;

  const grouped = new Map<string, DocsRecord[]>();
  for (const record of index.records) {
    const id = pageIdOf(record);
    const group = grouped.get(id);
    if (group) group.push(record);
    else grouped.set(id, [record]);
  }

  const list: DocsPage[] = [];
  const byPath = new Map<string, DocsPage>();
  const byId = new Map<string, DocsPage>();
  const byUrl = new Map<string, DocsPage>();
  for (const [id, group] of grouped) {
    const head = group.find((record) => record.id === id) ?? group[0]!;
    const records = [head, ...group.filter((record) => record !== head)];
    const path = pagePathOf(id);
    if (byPath.has(path)) throw new Error(`Docs index has two pages at path "${path}"`);
    const page: DocsPage = {
      id,
      path,
      uri: `bioc://docs/${path}`,
      url: pageUrlOf(head),
      title: head.title,
      crumbs: head.crumbs,
      source: head.source,
      repo: head.repo ?? null,
      records,
      input: index.inputFor(records[0]!.id)!,
    };
    list.push(page);
    byPath.set(path, page);
    byId.set(id, page);
    byUrl.set(page.url, page);
  }

  const pages: DocsPages = {
    list,
    byPath,
    byId,
    byUrl,
    section(page, fragment) {
      const hash = new URL('#' + fragment, page.url).hash;
      return page.records.find((record) => new URL(record.url).hash === hash);
    },
    pageOf: (record) => byId.get(pageIdOf(record)),
  };
  cache.set(index, pages);
  return pages;
}

/** Section label: record.section; else the URL fragment as words ('why-at-the-edge' → 'Why at the edge'); '' for a page-level record. */
export function sectionLabel(record: DocsRecord): string {
  if (record.section !== '') return record.section;
  if (record.id === record.id.split('#')[0]) return '';
  const fragment = new URL(record.url).hash.slice(1);
  let decoded: string;
  try {
    decoded = decodeURIComponent(fragment);
  } catch {
    decoded = fragment;
  }
  const words = decoded.replaceAll('-', ' ').replace(/ +/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function body(record: DocsRecord): string {
  let text = record.text;
  if (record.source !== 'repo' && record.section !== '' && text.startsWith(record.section + '\n')) {
    text = text.slice(record.section.length + 1);
  }
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

function withBody(head: string, text: string): string {
  return text === '' ? head : `${head}\n\n${text}`;
}

/** '<## or ###> <label>\n\n<url>\n\n<body>' (an empty body leaves the URL line last); `level` 3 for a nested record. */
export function renderSection(record: DocsRecord, level: 2 | 3 = 2): string {
  return withBody(`${'#'.repeat(level)} ${sectionLabel(record) || record.title}\n\n${record.url}`, body(record));
}

/**
 * The records nested under `record` on `page`: the maximal run of records right after it in
 * page.records whose crumbs are [...record.crumbs, record.section]. [] for the page-level record
 * or a record whose section is ''.
 */
export function subsectionsOf(page: DocsPage, record: DocsRecord): DocsRecord[] {
  if (record.id === page.id || record.section === '') return [];
  const at = page.records.indexOf(record);
  if (at === -1) return [];
  const crumbs = [...record.crumbs, record.section];
  const nested: DocsRecord[] = [];
  for (const next of page.records.slice(at + 1)) {
    if (next.crumbs.length !== crumbs.length || next.crumbs.some((crumb, i) => crumb !== crumbs[i])) break;
    nested.push(next);
  }
  return nested;
}

/** renderSection(record), then renderSection(s, 3) for each of subsectionsOf(page, record), joined by '\n\n'. */
export function renderSectionTree(page: DocsPage, record: DocsRecord): string {
  return [renderSection(record), ...subsectionsOf(page, record).map((s) => renderSection(s, 3))].join('\n\n');
}

/**
 * '# <title>\n\n<page url>\n\n<page-level body>' + '\n\n' + renderSection(r, level) for every other record,
 * level 3 when r has more crumbs than the page (an h3), else 2.
 * An ADR's page-level record holds the whole ADR, and its section records repeat that text; the page-level
 * body is cut where the first section's body last starts, which keeps the 'Status:' and 'Date:' lines and never
 * drops intro text that repeats it.
 */
export function renderPage(page: DocsPage): string {
  const [head, ...rest] = page.records as [DocsRecord, ...DocsRecord[]];
  const isPageLevel = head.id === page.id;
  const sections = isPageLevel ? rest : page.records;
  const parts = [withBody(`# ${page.title}\n\n${page.url}`, isPageLevel ? pagePreamble(head, rest) : '')];
  for (const record of sections) parts.push(renderSection(record, record.crumbs.length > page.crumbs.length ? 3 : 2));
  return parts.join('\n\n');
}

function pagePreamble(head: DocsRecord, sections: DocsRecord[]): string {
  const pageBody = body(head);
  const first = sections.map(body).find((text) => text !== '');
  const at = first === undefined ? -1 : pageBody.lastIndexOf(first);
  return at === -1 ? pageBody : pageBody.slice(0, at).trim();
}

/** Provenance for a docs result: the page's public URL (no #anchor), dated by the input it was built from. */
export function docsPageSource(page: DocsPage): Source {
  return { url: page.url, as_of: docsSource(page.input).as_of };
}

/** Provenance for an index input: { url: input.url, as_of: input.last_modified ?? input.fetched_at }. */
export function docsSource(input: DocsInput): Source {
  return { url: input.url, as_of: input.last_modified ?? input.fetched_at };
}
