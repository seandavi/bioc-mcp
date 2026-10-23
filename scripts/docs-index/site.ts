import * as z from 'zod';
import type { DocsRecord } from '../../src/docs-index/schema';

const SearchEntrySchema = z.looseObject({
  href: z.string().min(1),
  title: z.string(),
  section: z.string(),
  text: z.string(),
  crumbs: z.array(z.string()).nullish(),
});

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', '#39': "'" };

/** One pass, so `&amp;lt;` becomes `&lt;`, not `<`. */
function decode(value: string): string {
  return value.replace(/&(lt|gt|amp|quot|#39);/g, (_match, name: string) => ENTITIES[name] as string);
}

/** Quarto search.json → records. Throws Error naming the first entry that does not parse. */
export function siteRecords(searchJson: unknown, siteUrl: string): DocsRecord[] {
  if (!Array.isArray(searchJson)) throw new Error('search.json is not an array');
  const base = new URL(siteUrl);
  const seen = new Set<string>();
  return searchJson.map((raw: unknown, index) => {
    const parsed = SearchEntrySchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`search.json entry ${index} is not valid: ${z.prettifyError(parsed.error)}`);
    }
    const entry = parsed.data;
    const id = `site:${entry.href}`;
    if (seen.has(id)) throw new Error(`Duplicate docs record id: ${id}`);
    seen.add(id);
    const url = new URL(entry.href, siteUrl);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
      throw new Error(`search.json entry ${index} href leaves site_url: ${entry.href}`);
    }
    return {
      id,
      url: url.href,
      title: decode(entry.title),
      section: decode(entry.section),
      crumbs: (entry.crumbs ?? []).map(decode),
      text: decode(entry.text),
      source: entry.href.startsWith('adr/') ? 'adr' : 'site',
    };
  });
}

/** A level-3 section of a rendered Quarto page: its id (the URL fragment) and heading text. */
export interface SiteSubsection {
  id: string;
  heading: string; // tags stripped, entities decoded, whitespace collapsed, trimmed
}

const SECTION_HEADING = /<section id="([^"]+)" class="level([23])\b[^"]*"[^>]*>\s*<h\2\b[^>]*>([\s\S]*?)<\/h\2>/g;

/**
 * Level-3 sections of one rendered Quarto page, keyed by the id of the enclosing level-2 section,
 * in document order. Level-3 sections before the first level-2 section are omitted.
 */
export function siteSubsections(html: string): Map<string, SiteSubsection[]> {
  const byParent = new Map<string, SiteSubsection[]>();
  let parent: string | undefined;
  for (const match of html.matchAll(SECTION_HEADING)) {
    const [, id, level, inner] = match as unknown as [string, string, string, string];
    if (level === '2') {
      parent = id;
      continue;
    }
    if (parent === undefined) continue;
    const heading = decode(inner.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
    const list = byParent.get(parent);
    if (list) list.push({ id, heading });
    else byParent.set(parent, [{ id, heading }]);
  }
  return byParent;
}

const squash = (line: string) => line.replace(/\s+/g, ' ').trim();

/**
 * Splits each site record whose href has a fragment at the level-3 headings Quarto rendered inside
 * that h2 section. subsectionsByPage is keyed by page href (the part before '#'). Records without
 * subsections pass through unchanged. Output order: each parent, then its subsections in document order.
 * Throws Error naming the record id, the subsection id and the heading when no line of the
 * parent's text (after the previous cut) equals the heading.
 */
export function splitSiteRecords(
  records: DocsRecord[],
  subsectionsByPage: ReadonlyMap<string, ReadonlyMap<string, SiteSubsection[]>>,
  siteUrl: string,
): DocsRecord[] {
  return records.flatMap((record) => {
    if (record.source === 'repo') return [record];
    const [page, fragment] = record.id.slice('site:'.length).split('#') as [string, string | undefined];
    if (fragment === undefined) return [record];
    const subsections = subsectionsByPage.get(page)?.get(fragment);
    if (!subsections || subsections.length === 0) return [record];

    const lines = record.text.split('\n');
    const cuts: number[] = [];
    let from = 0;
    for (const sub of subsections) {
      const at = lines.findIndex((line, i) => i >= from && squash(line) === sub.heading);
      if (at === -1) {
        throw new Error(`${record.id}: no line "${sub.heading}" for subsection #${sub.id} in search.json text`);
      }
      cuts.push(at);
      from = at + 1;
    }
    const parent: DocsRecord = { ...record, text: lines.slice(0, cuts[0]).join('\n').trim() };
    const children = subsections.map((sub, k): DocsRecord => ({
      ...record,
      id: `site:${page}#${sub.id}`,
      url: new URL(`${page}#${sub.id}`, siteUrl).href,
      section: sub.heading,
      crumbs: [...record.crumbs, record.section],
      text: lines.slice(cuts[k], cuts[k + 1]).join('\n').trim(),
    }));
    return [parent, ...children];
  });
}
