# Spec #61: Docs search ranking, recall@5 from 0.735 to at least 0.8

Issue: [seandavi/bioc-mcp#61](https://github.com/seandavi/bioc-mcp/issues/61). It follows the eval of
[Spec #5](5-docs-eval.md) and builds on [Spec #3](3-docs-index.md) (the index),
[Spec #4](4-docs-module.md) (`docs_search`, `docs_read`) and [Spec #45](45-followups-docs.md).
Project design: [proposal-mcp.qmd](https://github.com/seandavi/bioc-infrastructure/blob/spec/mcp/proposal-mcp.qmd)
("Docs search": lexical first; embeddings only if lexical recall@5 stays below about 80%).
Conventions: [AGENTS.md](../../AGENTS.md).

Checked on 2026-10-22 against `main` at `270d8a1` with `npm ci` (minisearch 7.2.0 as locked).
`npm test` passes there (975 tests). The experiments ran as throwaway scripts in `/tmp` over the
fixture build plus the live site HTML. **Verified** marks what those scripts showed:

- **Verified:** today's baseline differs from the issue's. `npm run eval:docs` reports
  **recall@1 0.471 (16/34), recall@5 0.735 (25/34), MRR@10 0.583** over 418 records. (The issue's
  0.706 was measured before #45 changed the answers to real record ids.)
- **Verified:** Quarto's `search.json` splits pages at h2 only. `operations.html#runbooks` is one
  6,084-character record that holds all seven runbooks (h3). `dns-cutover.html#migration-plan`
  and `astro-site-build.html#the-2026-08-04-build-record` are blobs of the same kind, and they show
  up in the top 3 of many unrelated questions.
- **Verified:** the h3 ids are often explicit and cannot be derived from the heading text.
  `operations.qmd` has `### Roll back the Worker {#rollback-worker}`, for example. The rendered
  HTML carries them as `<section id="rollback-worker" class="level3">` followed by
  `<h3 class="anchored" data-anchor-id="rollback-worker">Roll back the Worker</h3>`. The per-page
  `*.llms.md` files have the headings but no ids.
- **Verified:** across the 41 site pages, 14 have level-3 sections, 117 in all. Every one sits
  inside a level-2 section (none comes before the first h2, and no ADR has one). Each heading's
  text, with tags stripped and entities decoded, equals a whole line, once trimmed, of its parent
  h2 record's `search.json` text. That holds for all 117. Some headings contain markup: `<code>`
  in `dns-cutover.html`, `<a>` in `ci.html` and `roadmap.html`. Every
  `<section … class="level2|3">` tag is exactly `<section id="…" class="levelN">`, with no other
  classes or attributes. The 41 HTML pages total 2.77 MB, and the largest is 124 KB.
- **Verified:** the live `search.json` sha256 equals the fixture's
  (`6458f04d48beb666ad9dde01684bdbe576c7d4fc04bc53dae7a1816d27f3e503`), so HTML fetched today
  comes from the same deploy as the committed `search.json`. Two repo fixtures differ from live:
  `bioc-mcp/main/README.md` and `bioc-registry/main/docs/api.md`.
- **Verified:** in minisearch 7.2.0, `SearchOptions.prefix` and `fuzzy` accept
  `(term, i, terms) => boolean` and `(term, i, terms) => boolean | number`
  (`dist/es/index.d.ts:319,342`). `boostDocument?: (documentId, term, storedFields) => number`
  multiplies a document's score per matched term (`:307`, `index.js:1723`). `executeQuery` merges
  per-call options over the constructor's `searchOptions` (`index.js:1565,1578`), so
  `search(q, { boostDocument, filter })` keeps `DOCS_INDEX_OPTIONS.searchOptions`. BM25+ uses
  `d = 0.5` (`index.js:1918`): every matched query term adds at least `0.5 × idf` whatever the
  field length. Stop words and one-letter prefix expansions therefore favour long records.
- **Verified:** ADR 0009 (`Status: Superseded by 0012 …`) and ADR 0001 (`Status: Superseded by
  ADR 0008 …`) are the only superseded ADRs. Their status line is in the page-level record text
  only, as a line starting `Status: Superseded`.
- **Verified:** measured numbers for each step are in [Expected numbers](#expected-numbers). They
  come from a harness that reproduces `docs_search` ranking. The harness does not apply the 8 KB
  envelope trim, so its baseline MRR is 0.586 where the real eval gives 0.583.

No new npm package, capability, MCP tool, REST route or `meta.inputs` entry. One new kind of
upstream call (site page HTML at build time) with 41 new fixtures.

## Goal

Raise `docs_search` recall@5 on `eval/docs-questions.yaml` (fixture index) from 0.735 to at
least 0.8. Recall@1 must not drop. The four changes the issue names land one at a time, each
measured:

1. **Split site sections at h3.** At index build, each site h2 record is split at its level-3
   headings, so each runbook (and each DNS-cutover step) becomes its own record. `docs_read` on
   an h2 URL still returns the whole h2 section, subsections included.
2. **Query stop words.** `DocsIndex.search` drops a fixed list of English stop words from the
   query, unless that would leave no terms.
3. **Length-gated prefix and fuzzy matching.** Prefix expansion runs only for terms of 4 or more
   characters, fuzzy matching (0.2) only for terms of 6 or more.
4. **Field boosts.** `{ title: 3, section: 2 }` becomes `{ title: 3, section: 3 }`, chosen from a
   table of measured variants.
5. **Superseded ADRs rank lower.** Records of an ADR whose status line says `Superseded` score
   × 0.75.

The PR body has the eval table for the baseline and after each step, the boost table, and one
`--network` run of the final state.

## Non-goals

- **No change to any capability's input or output schema,** tool name, description, REST route
  or envelope. `docs_search` hits keep their shape. ADR status is not surfaced in hits (a
  possible follow-up).
- **No semantic search** (Cloudflare AI Search, Vectorize, embeddings). Lexical tuning clears 0.8,
  so the issue's fallback is not triggered.
- **No snippet change.** `snippet()` still centres on the first query word of 3 or more
  characters, stop words included.
- **No index-time stop words, stemming or `processTerm`.** The serialized index keeps today's
  terms. Only the query and `searchOptions` change.
- **No h4 splitting** (3 h4s on the whole site) and **no split of page-level records** (no h3
  comes before the first h2 today, and ADR page-level records hold the whole ADR).
- **No change to repo Markdown splitting** (`markdownRecords` already splits at levels 1–3).
- **No new `DOCS_FORMAT_VERSION`.** `DocsRecord` and the store shape do not change.
- **No rewording of questions** and no narrowing of answers. Answers move only where a split moves
  the text that answers them (see [Eval answers](#eval-answers)).
- **No score threshold test.** Scores stay report-only (Spec #5).

## Design

### Files

| File | Change |
|---|---|
| `scripts/docs-index/site.ts` | Add `SiteSubsection`, `siteSubsections(html)` and `splitSiteRecords(records, subsectionsByPage, siteUrl)`. |
| `scripts/docs-index/build.ts` | After `siteRecords`, fetch each site page's HTML and split the site records before adding them. |
| `src/docs-index/load.ts` | Add `QUERY_STOP_WORDS`, a stop-word step in `boundedQuery`, `SUPERSEDED_ADR_BOOST`, and the `boostDocument` passed to every `miniSearch.search` call. |
| `src/docs-index/schema.ts` | `DOCS_INDEX_OPTIONS.searchOptions`: new boosts and length-gated `prefix` and `fuzzy`, with exported constants. |
| `src/core/docs/pages.ts` | Add `subsectionsOf(page, record)` and `renderSectionTree(page, record)`. |
| `src/core/docs/read.ts`, `src/core/docs/resources.ts` | Section targets render with `renderSectionTree` instead of `renderSection`. |
| `eval/docs-questions.yaml` | Answers re-pointed from split h2 records to the h3 records that now hold the text (list below). |
| `test/fixtures/docs/seandavi.github.io/bioc-infrastructure/**/*.html` | 41 new fixtures, one per site page. |
| `test/docs-index/__snapshots__/build-summary.json` | Regenerated (`npx vitest run -u test/docs-index`). |
| `docs-sources.yaml` | `site_url` comment: page HTML is fetched from there too. |
| `AGENTS.md` | Docs-index rule: the build also fetches each site page's HTML for h3 structure, and its fixtures sit next to `search.json`. |
| Tests | See [Test plan](#test-plan). |

### 1. Site h3 split (build time)

In `scripts/docs-index/site.ts`:

```ts
/** A level-3 section of a rendered Quarto page: its id (the URL fragment) and heading text. */
export interface SiteSubsection {
  id: string;
  heading: string; // tags stripped, entities decoded (decode()), whitespace collapsed, trimmed
}

/**
 * Level-3 sections of one rendered Quarto page, keyed by the id of the enclosing level-2 section,
 * in document order. Level-3 sections before the first level-2 section are omitted.
 */
export function siteSubsections(html: string): Map<string, SiteSubsection[]>;

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
): DocsRecord[];
```

`siteSubsections` scans with one regex, in order:

```ts
const SECTION_HEADING = /<section id="([^"]+)" class="level([23])\b[^"]*"[^>]*>\s*<h\2\b[^>]*>([\s\S]*?)<\/h\2>/g;
```

A level-2 match sets the current h2 id. A level-3 match while an h2 is current appends
`{ id, heading }` under that h2 id. The heading is
`decode(inner.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()`, using the existing
one-pass `decode` in `site.ts`. No HTML parser library is needed: the regex matched all 117
level-3 sections on the live site (see Verified).

`splitSiteRecords`, for a record `r` with `r.source !== 'repo'` whose id is
`site:<page>#<frag>` and with `subsectionsByPage.get(page)?.get(frag)` non-empty:

- `lines = r.text.split('\n')`. For each subsection in order, find the first index `i` at or after
  the previous cut + 1 with `lines[i].replace(/\s+/g, ' ').trim() === heading`. Not found: throw
  `Error(\`${r.id}: no line "${heading}" for subsection #${id} in search.json text\`)`.
- Parent: `{ ...r, text: lines.slice(0, cut[0]).join('\n').trim() }`. Same id, url, section and
  crumbs.
- Subsection k: `{ ...r, id: \`site:${page}#${sub.id}\`, url: new URL(\`${page}#${sub.id}\`, siteUrl).href,
  section: sub.heading, crumbs: [...r.crumbs, r.section], text: lines.slice(cut[k], cut[k + 1]).join('\n').trim() }`.
  `title` and `source` come from the parent (so ADR subsections stay `'adr'`), and there is no
  `repo` key. The text starts with the heading line, as `search.json` section texts do, so
  `body()` in `pages.ts` strips it as it does for h2 records.
- Page-level records (no `#`) and records whose page or h2 has no subsections are returned as they
  are.

In `buildDocsIndex` (`scripts/docs-index/build.ts`), replace
`add(site.response, siteRecords(site.json, config.site_url))` with:

```ts
const flat = siteRecords(site.json, config.site_url);
// Page HTML is read only for h3 structure; the text and provenance stay search.json's (no meta.inputs entry).
const subsectionsByPage = new Map<string, Map<string, SiteSubsection[]>>();
for (const record of flat) {
  const page = record.id.slice('site:'.length).split('#')[0]!;
  if (subsectionsByPage.has(page)) continue;
  const response = await fetchUpstream(fetchDeps, docsSite, page.split('/').map(pathSegment).join('/'));
  subsectionsByPage.set(page, siteSubsections(response.body));
}
add(site.response, splitSiteRecords(flat, subsectionsByPage, config.site_url));
```

The fetches run one at a time in first-appearance order: 41 requests, deterministic, gentle on
Pages. They use the existing `docsSite` upstream: same base URL, `fetchUpstream`'s redirect
guard, the default 2 MiB `maxBytes`, and a 30 s timeout. Any fetch failure throws, as now (no
partial build). The page HTML is not a `meta.inputs` entry. None of its text is indexed, and 41
more inputs would almost quadruple the dataset's `inputs` list in `bioc://about` and
`/api/v1/about` without adding provenance for any indexed text. The `search.json` input's
`record_count` grows to 381 and owns the subsection records.

Example upstream calls (GET, through `fetchUpstream`):

- `https://seandavi.github.io/bioc-infrastructure/operations.html`
- `https://seandavi.github.io/bioc-infrastructure/adr/0009-client-addresses-are-hashed-at-the-edge.html`

Fixtures: one file per site page at
`test/fixtures/docs/seandavi.github.io/bioc-infrastructure/<href before #>`. That is 28 top-level
`*.html` and 13 under `adr/`, the 41 distinct pages of the fixture `search.json`. Record them with
`npm run docs:record`. Then restore every non-HTML fixture
(`git checkout -- test/fixtures/docs/raw.githubusercontent.com test/fixtures/docs/seandavi.github.io/bioc-infrastructure/search.json`),
so the baseline stays comparable and the HTML matches the committed `search.json`. First check
that the live `search.json` sha256 is still `6458f04d…`. If it is not, re-record everything, run
the eval on the new fixtures as the new step-0 baseline, and say so in the PR. `fixtureDocsFetch`
serves `.html` as `text/plain`, which `fetchUpstream` does not check.

Result on the fixtures: 535 records (381 site/adr, 154 repo), 16 inputs.

### 2. `docs_read` of a split h2 still reads the whole h2

After the split, `operations.html#runbooks` has only its 347-character intro, and
`how-it-works.html#serving` only its heading. Without this change, a `docs_read` of those URLs
(from older hits, links or memory) would return almost nothing. In `src/core/docs/pages.ts`:

```ts
/**
 * The records nested under `record` on `page`: the maximal run of records right after it in
 * page.records whose crumbs are [...record.crumbs, record.section]. [] for the page-level record
 * or a record whose section is ''.
 */
export function subsectionsOf(page: DocsPage, record: DocsRecord): DocsRecord[];

/** renderSection(record), then renderSection(s) for each of subsectionsOf(page, record), joined by '\n\n'. */
export function renderSectionTree(page: DocsPage, record: DocsRecord): string;
```

`docs_read` (`read.ts`, the `full` text of a section target) and the `docs-page` resource
(`resources.ts`, a section target) use `renderSectionTree(target.page, target.record)`.
Everything else in the read envelope stays as it is (`kind`, `url`, `section`, `crumbs`,
paging). The same rule applies to repo Markdown, whose h3 records already carry
`[...h2 crumbs, h2]`. A repo h2 read now includes its h3s too, which is the same improvement.
`renderPage` does not change: it already renders every record of the page in order.

### 3. Query stop words (`src/docs-index/load.ts`)

```ts
/** English function words and question words that search() drops from a query (lower case). */
export const QUERY_STOP_WORDS: ReadonlySet<string> = new Set([
  'a', 'about', 'all', 'am', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'because', 'been', 'being',
  'both', 'but', 'by', 'can', 'could', 'did', 'do', 'does', 'doing', 'during', 'each', 'for', 'from',
  'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'herself', 'him', 'himself', 'his',
  'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself', 'just', 'me', 'my', 'myself', 'of',
  'on', 'or', 'our', 'ours', 'ourselves', 'she', 'should', 'so', 'some', 'such', 'than', 'that',
  'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they', 'this', 'those',
  'through', 'to', 'until', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who',
  'whom', 'why', 'will', 'with', 'would', 'you', 'your', 'yours', 'yourself', 'yourselves',
]); // 98 words
```

The list leaves out words that carry meaning in these docs: `not`, `no`, `off`, `up`, `down`,
`out`, `over`, `under`, `before`, `after`, `again`, `against`, `between`, `only`, `same`,
`other`, `more`, `most`. A broader list that dropped them measured the same recall@5 and the
same or lower recall@1.

`boundedQuery(query)` becomes: tokenize and lower-case as now. Collect distinct non-stop terms
up to `MAX_SEARCH_TERMS`, stopping when that many are collected. Separately collect distinct
stop-word terms, also up to `MAX_SEARCH_TERMS`. Return the non-stop terms joined by `' '`, or
the stop-word terms if there are no non-stop terms (so `"how do I"` still searches). Update the
`DocsIndex.search` doc comment to say so. `MAX_SEARCH_TERMS` keeps its value (16) and now
counts non-stop terms. Every caller of `index.search` gets this: `docs_search` and the
close-match lookups in `read.ts`.

### 4. Prefix and fuzzy gated by term length (`src/docs-index/schema.ts`)

```ts
/** Query terms shorter than this get no prefix expansion. */
export const PREFIX_MIN_LENGTH = 4;
/** Query terms shorter than this get no fuzzy matching. */
export const FUZZY_MIN_LENGTH = 6;
/** Fuzzy edit distance as a fraction of term length (MiniSearch rounds; 6–7 letters → 1 edit). */
export const FUZZY_FRACTION = 0.2;

// in DOCS_INDEX_OPTIONS
searchOptions: {
  boost: { title: 3, section: 3 },
  prefix: (term: string) => term.length >= PREFIX_MIN_LENGTH,
  fuzzy: (term: string) => (term.length >= FUZZY_MIN_LENGTH ? FUZZY_FRACTION : false),
},
```

`searchOptions` does not affect the serialized index, so this needs no format change. It also
cuts query cost: Spec #45 measured one-letter prefix expansions as the expensive case. The
`MAX_SEARCH_TERMS` doc comment ("each costs one prefix and one fuzzy sub-query") becomes "at most
one prefix and one fuzzy sub-query".

### 5. Field boosts

`boost: { title: 3, section: 3 }` (above). It is chosen by re-measuring the variants in
[Expected numbers](#expected-numbers) step 4 with the real eval (temporarily editing `boost`) and
taking the one with the highest recall@5, then recall@1, then MRR@10, preferring today's values
on a tie. If the real eval ranks them differently from the harness, use the real eval's winner
and record the table as measured.

### 6. Superseded ADRs (`src/docs-index/load.ts`)

```ts
/** search() multiplies the score of every record of a superseded ADR by this. */
export const SUPERSEDED_ADR_BOOST = 0.75;
```

In `loadDocsIndex`, build `superseded: Set<string>` of page ids, one for each record with
`source === 'adr'`, no `#` in its id, and text matching `/^Status: Superseded\b/m`. Pass
`boostDocument: (id: string) => (superseded.has(id.split('#')[0]!) ? SUPERSEDED_ADR_BOOST : 1)`
to both `miniSearch.search` calls in `search()`: with and without `filter`, which stays as it
is. On the fixtures that is ADR 0009 and ADR 0001. The value sits in the middle of the measured
plateau: 0.6–0.9 all give the same numbers, and 0.5 drops the `publication-boundary` question,
whose answer is the superseded ADR 0001.

### Schemas, tools and routes

Unchanged. `DocsSearchInputSchema`, `DocsSearchDataSchema`, `DocsSearchHitSchema`,
`DocsReadInputSchema` and `DocsReadDataSchema` stay as they are. So do the MCP tools
`docs_search` and `docs_read` and the REST routes `GET /api/v1/docs/search` and
`GET /api/v1/docs/read`. `hit.score` remains "BM25+ score … comparable only within one result"
and now includes the boosts. `DocsRecordSchema`, `DocsStoreSchema` and `DOCS_FORMAT_VERSION`
(1) do not change.

### Eval answers

`eval/docs-questions.yaml` changes only these `answers` (questions and `from` unchanged). The
fixture-index check in `test/docs-eval/questions.test.ts` would fail without them. Each new URL
is the record that now holds the text that answered, named by the question's own `from` where
it gives an anchor:

| id | removed | added |
|---|---|---|
| `runbook-failed-sync` | `operations.html#runbooks` | `operations.html#failed-sync` |
| `runbook-purge` | `operations.html#runbooks` | `operations.html#purge` (keeps `cache.html#purging`) |
| `runbook-rollback-worker` | `operations.html#runbooks` | `operations.html#rollback-worker` |
| `runbook-rollback-site` | `operations.html#runbooks` | `operations.html#rollback-site` |
| `runbook-yank` | `operations.html#runbooks` | `operations.html#yank` |
| `runbook-rollback-dns` | `operations.html#runbooks`, `dns-cutover.html#migration-plan` | `operations.html#rollback-dns`, `dns-cutover.html#change-the-nameservers` (roll back to Route53), `dns-cutover.html#flip-the-site-m1-proper` (the DNS-only rollback) |
| `who-generates-stats` | `how-it-works.html#serving` | `how-it-works.html#request-order` (bioc-traffic uploads the stats to R2 and the Worker serves them) |

All URLs are under `https://seandavi.github.io/bioc-infrastructure/`. The other split parents
that are answers keep their intro text, which still answers on its own:
`propagation-gate.html#the-gate-check-by-check` (4,510 characters),
`propagation-gate.html#why-the-registry-polls` and `download-stats.html#do-the-two-systems-agree`.
Those answers stay as they are.

### Expected numbers

Harness numbers on the fixtures, cumulative, with the answers above from step 1 on. The real
`npm run eval:docs` may differ slightly (8 KB trim). The PR reports the real ones.

| Step | records | recall@1 | recall@5 | MRR@10 |
|---|---|---|---|---|
| 0 baseline (real eval) | 418 | 0.471 | 0.735 | 0.583 |
| 1 + h3 split | 535 | 0.559 | 0.735 | 0.636 |
| 2 + stop words | 535 | 0.588 | 0.853 | 0.697 |
| 3 + prefix ≥ 4, fuzzy ≥ 6 | 535 | 0.706 | 0.882 | 0.772 |
| 4 + boost title 3, section 3 | 535 | 0.735 | 0.912 | 0.795 |
| 5 + superseded ADR × 0.75 | 535 | 0.765 | 0.912 | 0.810 |

Step 4 variants (with steps 1–3): `{1,1}` 0.706/0.882/0.781; `{2,2}` 0.735/0.882/0.798;
`{1,2}` 0.735/0.882/0.804; `{2,3}` 0.706/0.882/0.791; `{3,2}` 0.706/0.882/0.772; `{3,3}`
0.735/0.912/0.795; `{4,3}` 0.735/0.912/0.794; `{3,4}` 0.676/0.882/0.771 (title/section;
r@1/r@5/MRR). Ablations of the final state: without the split 0.588/0.853/0.702; without stop
words 0.618/0.765/0.688; with the old `prefix: true, fuzzy: 0.2` 0.647/0.853/0.744.

Step 1 alone does not move recall@5, but it raises recall@1 and MRR and is what lets steps 2–5
find single runbooks. Keep rule for the PR: a step is kept if it does not lower recall@1 and
raises recall@5 or MRR@10. Each step above meets it. A step that fails it on the real eval is
dropped, and the PR says so.

Known remaining misses in the final state (harness): `runbook-purge` 2, `runbook-rollback-site` 4,
`who-generates-stats` 4, `empty-october-stats` 3, `intelligence-sources` 5, and outside the top 10
`completeness-by-origin`, `stats-agree` and `add-to-manifest`. `stats-agree` gets worse (it was
rank 2). The PR lists it as a regression.

## Acceptance criteria

- [ ] `npm run docs:fixtures` builds 535 records: 381 with `source` `site` or `adr`, all of them
      before the 154 `repo` records. There are 16 `meta.inputs`, with `meta.inputs[0].record_count === 381`.
- [ ] The fixture index has `site:operations.html#rollback-worker` with url
      `https://seandavi.github.io/bioc-infrastructure/operations.html#rollback-worker`, section
      `Roll back the Worker`, crumbs `['Overview', 'Operating', 'Operations & Runbooks', 'Runbooks']`,
      source `site`, and text starting `Roll back the Worker\n`. `site:operations.html#runbooks`
      still exists, and its text no longer contains `wrangler rollback`.
- [ ] Each of the 7 `operations.html` runbook ids (`deploy-worker`, `rollback-worker`,
      `rollback-site`, `failed-sync`, `purge`, `yank`, `rollback-dns`) is a record. Each of the 117
      level-3 sections is a record whose text starts with its heading line.
- [ ] `docs_read` of `…/operations.html#runbooks` returns `kind: 'section'`. Its full text (all
      parts joined) contains `## Roll back the Worker` and `## Roll back DNS`, in that order. The
      same holds for `bioc://docs/operations.html#runbooks`.
- [ ] A build whose fetch has no route for a site page rejects with `CapabilityError` `not_found`
      naming that page URL. A page whose h3 heading is not a line of its h2 text makes
      `splitSiteRecords` throw naming the record id and heading.
- [ ] `index.search('how do I roll back the Worker')[0].record.id === 'site:operations.html#rollback-worker'`
      on the fixture index.
- [ ] A query of only stop words (`'how do I'`) still returns hits. `index.search('how do I purge the cache')`
      returns the same ids and scores as `index.search('purge cache')`.
- [ ] On a synthetic index: `'cac'` finds no record containing only `cache` (no prefix under 4),
      `'cach'` does. `'cachr'` finds nothing (no fuzzy under 6), and `'purgingg'` finds `purging`.
- [ ] On a synthetic index with two identical ADR pages, one `Status: Superseded by 0002`: the
      current ADR ranks first, and the superseded one's score is `SUPERSEDED_ADR_BOOST` times the
      other's (within 1e-9).
- [ ] `eval/docs-questions.yaml` differs from `main` only in the answers listed in
      [Eval answers](#eval-answers). `test/docs-eval/questions.test.ts` passes.
- [ ] `npm run eval:docs` (fixtures) reports recall@5 ≥ 0.8 and recall@1 ≥ 0.471.
- [ ] `npm test`, `npm run typecheck` and `npm run build` pass. `max_artifact_bytes` is not hit,
      and the PR states `generated/docs-index.js` bytes before and after.
- [ ] The PR body has the step table (real eval numbers, baseline and after each kept step), the
      boost variant table, the remaining misses, and one `npm run eval:docs -- --network` result.
      It says `Closes #61`.
- [ ] Commits, in order: (1) the h3 split, with fixtures, snapshot, eval answers, `docs_read`
      subsections, `docs-sources.yaml` and `AGENTS.md`; (2) stop words; (3) prefix/fuzzy gating;
      (4) boosts; (5) superseded ADRs. Each commit message carries the eval numbers after it. Each
      commit passes `npm test`.

## Test plan

All tests stay offline. New fixtures are the 41 HTML pages.

| File | Tests |
|---|---|
| `test/docs-index/site.test.ts` | `siteSubsections`: synthetic HTML with two h2 sections, h3s under each, an h3 before the first h2 (omitted), a heading with `<code>x</code> &amp; <a href="…">y</a>` (→ `x & y`), and extra classes (`class="level3 unnumbered"`). Over the `operations.html` fixture it returns the 7 runbook ids under `runbooks`. `splitSiteRecords`: a parent with two subsections gives parent intro, then children with the right id, url, section, crumbs, title, source and text. A record without subsections and a page-level record come back unchanged (`toBe` the same object or `toEqual`). A heading that matches only before the previous cut is not reused. A missing heading line throws naming the record id and heading. |
| `test/docs-index/build.test.ts` | `routesFor` adds a route for every site page fixture. Counts become 381 site / 535 total. New: the rollback-worker record (criterion 2); every one of the 117 subsections starts with its heading; a missing page route rejects `not_found` naming the page URL. Inputs stay 16. Snapshot regenerated. |
| `test/docs-index/load.test.ts` | Stop-word equivalence and the all-stop-word fallback (criterion 7). The rollback-worker ranking (criterion 6). The existing 16-term test still passes. The prefix/fuzzy length gates and the superseded boost on synthetic indexes (`syntheticDocsIndex`), criteria 8–9. A query of 16 stop words plus `registry` still finds `registry` hits (stop words do not use up the 16-term budget). |
| `test/core/docs/pages.test.ts` | `subsectionsOf`: run after an h2 record, ending at the first record with other crumbs. `[]` for the page-level record and for a record with section `''`. `renderSectionTree` equals `renderSection(parent) + '\n\n' + renderSection(child)…`. |
| `test/core/docs/read.test.ts`, `test/core/docs/resources.test.ts` | Criterion 4 (paging through `next_cursor` for the tool). Existing expectations that use `renderSection(record)` for a section with subsections (`propagation-gate.html#why-the-registry-polls` now has `#two-traps-in-the-data`) switch to `renderSectionTree(page, record)`. |
| `test/core/docs/search.test.ts` | Existing ranking cases are kept. `'why are client addresses hashed'` (source `adr`) may now rank another record of ADR 0009 first. If so, assert `hits[0].url.startsWith(<ADR 0009 page url>)`. Any other change to an existing case is a regression to report, not to edit away. |
| `test/docs-eval/questions.test.ts` | Unchanged. It checks the re-pointed answers exist. |

Manual: `npm run eval:docs` after each commit, `npm run eval:docs -- --network` once at the end,
and `npm run build` to compare bundle bytes.

## Risks

- **Overfitting to 34 questions.** One question is 0.029. Boosts in particular move by ±1
  question between variants. Mitigations: the stop words, the length gates and the split are
  general, not tuned per question. The boost choice follows a stated rule, the superseded weight
  sits mid-plateau, and every number goes in the PR. The `--network` run is a second, if
  correlated, check.
- **Daily build fragility.** The build now also depends on 41 page fetches and on Quarto's HTML
  shape (`<section id class="levelN"><hN>`). It also needs each h3 heading to appear as a line in
  `search.json`. A Quarto upgrade, a heading with footnotes or math, or a fetch that straddles a
  Pages deploy (new HTML with old `search.json`) makes the build throw. The Worker then keeps
  serving the previous index, and the failed Deploy run shows the message, which names the record
  and heading. That is the existing fail-loud policy, not a new one.
- **2.77 MB of HTML fixtures** in git, re-recorded whenever `docs:record` runs. Stored whole, as
  recorded ("land raw sources whole").
- **`docs_read` on h2 URLs now includes subsections,** for site and repo docs alike. Output for
  those sections gets longer, so they page sooner. The reviewer should confirm this is wanted
  rather than intro-only reads. The alternative leaves URLs like `how-it-works.html#serving`
  returning just a heading.
- **Stale `generated/docs-index.js`.** `npm test` builds it only `--if-missing`, so a checkout
  with an old 418-record artifact keeps it. Run `npm run docs:fixtures` after pulling. CI builds
  fresh.
- **Hit URLs change** for anything under a split h2. A client holding an old `#runbooks` URL still
  reads the whole section (above). Search now points at the specific runbook.
- **`stats-agree` regresses** (rank 2 → outside the top 10). It stays visible in the report as a
  candidate for a later issue (it needs the bioc-traffic comparison doc to rank).
