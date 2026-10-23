import * as z from 'zod';
import { envelopeBytes, MAX_RESULT_BYTES, type Envelope, type Source } from '../../envelope';
import { CapabilityError } from '../../errors';
import { ignoredSearchTerms, MAX_SEARCH_TERMS, type DocsIndex } from '../../docs-index/load';
import { DocsSourceKindSchema, type DocsInput, type DocsRecord } from '../../docs-index/schema';
import { defineCapability, type Capability } from '../capability';
import { docsFreshness, DocsFreshnessSchema, inputNote, type DocsFreshness } from './freshness';
import { docsPages, docsPageSource, docsSource, sectionLabel, subsectionsOf, type DocsPages } from './pages';

const SourceFilterSchema = z
  .string()
  .max(128)
  .regex(/^(site|adr|repo:[A-Za-z0-9._-]+)$/, "source must be 'site', 'adr' or 'repo:<name>'")
  .describe(
    "Narrow to 'site' (the infrastructure site's pages other than ADRs), 'adr' (architecture decision records) or 'repo:<name>' (one bioc-* repo's docs, e.g. 'repo:bioc-registry')",
  );

export const DocsSearchInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(256)
    .regex(/\S/, 'query must contain a non-space character')
    .describe(
      'Words to search for, e.g. "why does the registry poll". Common words such as "the" and "why" are skipped, ' +
        'and only the first 16 other distinct words are searched, so put the key words first',
    ),
  limit: z.number().int().min(1).max(10).default(8).describe('Maximum number of sections to return (1–10)'),
  source: SourceFilterSchema.optional(),
});

export const DocsSearchHitSchema = z.object({
  url: z.string().describe('Public URL of the section (with #anchor) or page; pass it to docs_read'),
  title: z.string().describe('Page or document title'),
  section: z.string().describe("Section heading (sectionLabel); '' when the hit is the page itself"),
  crumbs: z.array(z.string()).describe('Breadcrumb, outermost first'),
  source: DocsSourceKindSchema,
  repo: z.string().nullable().describe("The bioc-* repo for source 'repo'; else null"),
  snippet: z.string().describe('About 200 characters of the section around the first query word'),
  score: z.number().describe('BM25+ score, rounded to 2 decimals; comparable only within one result'),
  as_of: z.string().describe("When this hit's source was current (ISO 8601): the site's publish time or the build's fetch time"),
  source_commit: z
    .string()
    .nullable()
    .describe('Commit (40-hex sha) of the bioc-* repo or published site this hit was built from; null when unknown'),
});

export const DocsSearchDataSchema = z.object({
  query: z.string(),
  source: z.string().nullable(),
  hits: z.array(DocsSearchHitSchema).describe('Best first'),
  omitted_for_size: z.number().int().nonnegative().describe('Hits dropped from the end to stay under 8 KB'),
  freshness: DocsFreshnessSchema,
});
type DocsSearchData = z.output<typeof DocsSearchDataSchema>;

const SNIPPET_LENGTH = 200;
const SNIPPET_LEAD = 60;
const WORD_CHARACTER = /[\p{L}\p{N}]/u;

/** About 200 characters of `text` around the first query word (see below). Exported for tests. */
export function snippet(text: string, query: string): string {
  const plain = text.replace(/\s+/g, ' ').trim();
  if (plain.length <= SNIPPET_LENGTH) return plain;

  const lower = plain.toLowerCase();
  const words = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u))].filter((word) => word.length >= 3);
  let p = -1;
  for (let i = 0; i < lower.length && p === -1; i++) {
    const atWordStart = i === 0 || !WORD_CHARACTER.test(lower[i - 1]!);
    if (atWordStart && words.some((word) => lower.startsWith(word, i))) p = i;
  }

  let start = p <= 0 ? 0 : Math.max(0, p - SNIPPET_LEAD);
  if (start > 0) {
    const s = plain.indexOf(' ', start);
    if (s !== -1 && s < p) start = s + 1;
  }
  let end = Math.min(plain.length, start + SNIPPET_LENGTH);
  if (end < plain.length) {
    const e = plain.lastIndexOf(' ', end);
    if (e > start + 100) end = e;
    const last = plain.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
  }
  return (start > 0 ? '…' : '') + plain.slice(start, end) + (end < plain.length ? '…' : '');
}

/**
 * The text a hit's snippet is cut from: the record's text, or, when that is only the record's heading (an h2 whose
 * content is all in h3 subsections), the record's text and its subsections' texts joined by '\n'.
 */
function snippetSource(pages: DocsPages, record: DocsRecord): string {
  if (record.text.trim() !== record.section) return record.text;
  const page = pages.pageOf(record)!;
  return [record, ...subsectionsOf(page, record)].map((r) => r.text).join('\n');
}

function recordFilter(index: DocsIndex, source: string | undefined): ((record: DocsRecord) => boolean) | undefined {
  if (source === undefined) return undefined;
  if (source === 'site' || source === 'adr') return (record) => record.source === source;
  const name = source.slice('repo:'.length);
  const repos = [...new Set(index.records.flatMap((record) => (record.repo === undefined ? [] : [record.repo])))];
  if (!repos.includes(name)) {
    throw new CapabilityError(
      'invalid_input',
      `Unknown docs source "${source}". Valid: site, adr, ${repos.map((repo) => 'repo:' + repo).join(', ')}.`,
    );
  }
  return (record) => record.source === 'repo' && record.repo === name;
}

function describeHits(
  query: string,
  ignored: readonly string[],
  source: string | undefined,
  hits: DocsSearchData['hits'],
  omitted: number,
  inputs: readonly DocsInput[],
  freshness: DocsFreshness,
): string {
  const where = source ? ` in ${source}` : '';
  const stale = freshness.possibly_stale.map((warning) => `\nPossibly stale: ${warning}`).join('');
  const skipped =
    ignored.length === 0
      ? ''
      : `\nOnly the first ${MAX_SEARCH_TERMS} distinct words were searched (common words such as "the" and "why" are skipped); not searched: ${ignored.join(' ')}. Put the key words first.`;
  if (hits.length === 0) {
    return `No docs sections match "${query}"${where}. Try other words${source ? ' or drop source' : ''}. For live package state use pkg_status; for open issues or failing workflows use ops_activity.${skipped}${stale}`;
  }
  const n = hits.length;
  const lines = hits.map(
    (hit, i) => `\n${i + 1}. ${hit.title}${hit.section ? ` › ${hit.section}` : ''} ${hit.url} (${inputNote(inputs[i]!)})`,
  );
  const days = freshness.index_age_days;
  const built = `\nIndex built ${freshness.index_built_at.slice(0, 10)} (${days} day${days === 1 ? '' : 's'} old).`;
  const dropped =
    omitted > 0
      ? `\n${omitted} more hit${omitted === 1 ? ' was' : 's were'} dropped to stay under 8 KB; they rank below these. Narrow with source or more specific words to see others.`
      : '';
  return `${n} docs section${n === 1 ? '' : 's'} for "${query}"${where}:${lines.join('')}${skipped}${built}${stale}${dropped}`;
}

export function docsSearchCapability(
  getIndex: () => DocsIndex,
): Capability<typeof DocsSearchInputSchema, typeof DocsSearchDataSchema> {
  return defineCapability({
    module: 'docs',
    name: 'docs_search',
    title: 'Search the infrastructure docs',
    description:
      'Search the Bioconductor infrastructure docs for why or how something works: architecture ' +
      'decision records (ADRs), runbooks, design notes and API docs from the bioc-infrastructure site ' +
      'and the READMEs and docs of the seandavi/bioc-* repos. Returns ranked sections with title, url, ' +
      "breadcrumb, snippet and score. Pass a hit's url to docs_read for the full text. source narrows to " +
      "'site', 'adr' or 'repo:<name>' (e.g. 'repo:bioc-registry'). The docs describe design and " +
      "procedure, not live state: for a package's current build, check or propagation state use " +
      'pkg_status. Open issues, pull requests and failing workflows in the bioc-* repos are not in the ' +
      'docs: use ops_activity. Each hit carries as_of and source_commit; freshness says when the index ' +
      'was built and lists any reason a hit may be out of date.',
    input: DocsSearchInputSchema,
    data: DocsSearchDataSchema,
    async handler({ query, limit, source }, deps) {
      const index = getIndex();
      const q = query.trim();
      const ignored = ignoredSearchTerms(q);
      const found = index.search(q, limit, recordFilter(index, source));
      const pages = docsPages(index);
      const hitInputs = found.map(({ record }) => pages.pageOf(record)!.input);
      const hits = found.map(({ record, score }, i) => ({
        url: record.url,
        title: record.title,
        section: sectionLabel(record),
        crumbs: record.crumbs,
        source: record.source,
        repo: record.repo ?? null,
        snippet: snippet(snippetSource(pages, record), q),
        score: Math.round(score * 100) / 100,
        as_of: docsSource(hitInputs[i]!).as_of,
        source_commit: hitInputs[i]!.commit?.sha ?? null,
      }));
      const pageSources = found.map(({ record }) => docsPageSource(pages.pageOf(record)!));

      const build = (kept: number): Envelope<DocsSearchData> => {
        const sources: Source[] = [];
        for (const pageSource of pageSources.slice(0, kept)) {
          if (!sources.some((s) => s.url === pageSource.url)) sources.push(pageSource);
        }
        const omitted = hits.length - kept;
        const keptInputs = hitInputs.slice(0, kept);
        const freshness = docsFreshness(index.meta, keptInputs, deps.now());
        return {
          data: { query: q, source: source ?? null, hits: hits.slice(0, kept), omitted_for_size: omitted, freshness },
          summary: describeHits(q, ignored, source, hits.slice(0, kept), omitted, keptInputs, freshness),
          sources,
        };
      };

      let kept = hits.length;
      let envelope = build(kept);
      while (kept > 0 && envelopeBytes(envelope) > MAX_RESULT_BYTES) envelope = build(--kept);
      return envelope;
    },
  });
}
