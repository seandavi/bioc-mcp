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

/** '## <label>\n\n<url>\n\n<body>' (an empty body leaves the URL line last). */
export function renderSection(record: DocsRecord): string {
  return withBody(`## ${sectionLabel(record) || record.title}\n\n${record.url}`, body(record));
}

/** '# <title>\n\n<page url>\n\n<page-level body>' + '\n\n' + renderSection(r) for every other record. */
export function renderPage(page: DocsPage): string {
  const [head, ...rest] = page.records as [DocsRecord, ...DocsRecord[]];
  const isPageLevel = head.id === page.id;
  const parts = [withBody(`# ${page.title}\n\n${page.url}`, isPageLevel ? body(head) : '')];
  for (const record of isPageLevel ? rest : page.records) parts.push(renderSection(record));
  return parts.join('\n\n');
}

/** Provenance for an index input: { url: input.url, as_of: input.last_modified ?? input.fetched_at }. */
export function docsSource(input: DocsInput): Source {
  return { url: input.url, as_of: input.last_modified ?? input.fetched_at };
}
