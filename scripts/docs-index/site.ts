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
