# Spec #80: Follow-ups for the docs index, docs tools and eval (from the #5, #45, #56 and #61 reviews)

Issue: [seandavi/bioc-mcp#80](https://github.com/seandavi/bioc-mcp/issues/80). It bundles every
item of [#58](https://github.com/seandavi/bioc-mcp/issues/58) (the #5 review),
[#62](https://github.com/seandavi/bioc-mcp/issues/62) (the #45 review),
[#68](https://github.com/seandavi/bioc-mcp/issues/68) (the #61 review) and
[#77](https://github.com/seandavi/bioc-mcp/issues/77) (the #56 review). Builds on
[Spec #3](3-docs-index.md), [Spec #4](4-docs-module.md), [Spec #5](5-docs-eval.md),
[Spec #56](56-docs-freshness.md) and [Spec #61](61-docs-ranking.md). Project design:
[proposal-mcp.qmd](https://github.com/seandavi/bioc-infrastructure/blob/spec/mcp/proposal-mcp.qmd).
Conventions: [AGENTS.md](../../AGENTS.md).

Scope boundary: this bundle owns `src/core/docs/*`, `src/docs-index/*`, `scripts/docs-index/*`,
`scripts/docs-eval/*`, `src/core/about.ts`, their tests and specs. The parallel bundle
[#79](https://github.com/seandavi/bioc-mcp/issues/79) owns `src/core/pkg/*`, `src/upstreams/*`,
`src/core/ops/*`, `README.md` and `CONTRIBUTING.md`; nothing here edits those. Three small edits
fall outside both lists and are named in Risks: two description strings in `src/transports/`,
one comment block in `docs-sources.yaml`, and one line in `AGENTS.md`.

Checked on 2026-10-22 against `main` at d4c18f2 with the installed packages (minisearch 7.2.0,
zod 4.6.7, @hono/zod-openapi 1.6.3), using throwaway scripts outside the repo
(`npx tsx /tmp/spec80/*.mts`) over the fixture build (`npm run docs:fixtures`: 535 records,
16 inputs, 56 pages). `npm test` passes on that commit (62 files, 1,253 tests). **Verified**
marks what those scripts showed:

- **Verified:** `chunkText('aaaaa\nb cdddddd', 0, 10)` is `{ text: 'aaaaa\n', end: 6 }`
  (hard = 9, half = 4; newline at 5, space at 7, so a "last break of either kind" rule gives 8).
  `chunkText('aaaaaa bb\nccc dddd', 0, 12)` is `{ text: 'aaaaaa bb\n', end: 10 }`.
- **Verified:** the #62 example question has 10 distinct non-stop-word terms today (stop words
  arrived with #61), so it is no longer cut. All 34 eval questions have at most 11. A query with
  more than 16 distinct non-stop terms still loses the rest silently.
- **Verified:** in `syntheticDocsIndex` with two identical page-level ADR records (one
  superseded) and one identical `#decision` section record each, the superseded section's score
  is `0.75 ×` the current section's (ratio `0.7499999999999999`).
- **Verified:** no split site parent on the fixture corpus has `text === ''` after the h3 split,
  so no current cut is at line 0; starting the heading search at line 1 changes no record and the
  build snapshot stays the same.
- **Verified:** six site records (not five) have `text.trim() === section` after the h3 split:
  `how-it-works.html#serving` (4 subsections), `dns-cutover.html#undecided-needs-an-owner-…` (18),
  `cloudflare-account-migration.html#procedure` (5), `ci.html#new-system-pipeline` (4),
  `ci.html#platform-services` (1), `download-stats.html#two-data-quality-problems` (4).
  `index.search('cloudflare account migration procedure')` ranks `#procedure` first; its snippet is
  `"Procedure"` today. `snippet()` over the record's text joined with its subsections' texts by
  `'\n'` gives `"Procedure A. Prepare the new account (no user impact) Create the account under a
  Bioconductor-owned address. Add at least two more super administrators, and set the billing
  owner and payment method.…"`.
- **Verified:** every page's records have crumbs equal to the page's crumbs or one longer (adr:
  all equal; site: 117 one longer; repo: 44 one longer). The 23 repo records that are one longer
  but follow no h2 record of their own (e.g. `repo:bioc-registry/docs/api.md#get-sql` under the
  `Routes` h2, which has no record) are h3s in their source too.
- **Verified:** for every record in the fixture index, `record.url` starts with
  `inputPagesUrl(index.inputFor(record.id))` as defined below
  (`https://seandavi.github.io/bioc-infrastructure/` for the site input,
  `https://github.com/seandavi/<repo>/blob/main/<file>` for each repo input).
- **Verified:** `JSON.stringify(buildAbout(modules, now))` for the production `modules`
  (`meta`, `pkg`, `ops`, `docs`) over the fixture index is 10,604 bytes; the docs dataset's 16
  inputs are 7,051 of them (423–471 bytes each). All 16 fixture inputs have `sha === head_sha`.
  Without `commit.url` it is 9,029 bytes; dropping `head_sha`/`head_committed_at` when equal gives
  about the same (inputs 5,499 bytes) but loses the commit date of repo files.
- **Verified:** `.describe()` on nested `AboutSchema` fields reaches `/api/openapi.json` (the
  existing `DocsFreshnessSchema.possibly_stale` description appears there under `docs/search`;
  `datasets.items.properties.age_days` has none today).
- **Verified:** `scripts/build-docs-index.ts` passes `process.env.GITHUB_TOKEN` to the build and
  nothing else; it does not read `.dev.vars`. The fixture corpus has 14 recorded GitHub API
  responses (`test/fixtures/docs/api.github.com/`).

## Goal

Close every item of #58, #62, #68 and #77 in one PR. Each item is fixed, or (one optional
sub-item) declined with a reason. The PR body repeats this table so the four source issues can be
closed when it merges.

| Source | Id | Outcome | What changes |
|---|---|---|---|
| #58 | code-r0-1 | fix | `runDocsEval` reads hits through `DocsSearchDataSchema.parse` instead of a cast |
| #62 | code-r0-1 | fix | chunk test renamed to what it shows; new case where the space really is later; spec #4 and #45 rows |
| #62 | ux-r0-2 | fix | `query` describe says only the first 16 distinct non-stop words are used; `docs_search` summary names the words it left out (`ignoredSearchTerms`) |
| #68 | code-r0-1 | fix | superseded-ADR test adds section records and checks their ratio |
| #68 | code-r0-2 | fix | `splitSiteRecords` searches for headings from line 1; test with an h3 named like its h2 |
| #68 | code-r0-3 | fix | `siteSubsections` reads capture groups without the double cast |
| #68 | ux-r0-1 | fix | a hit whose text is only its heading gets its snippet from its subsections (six records on the fixtures) |
| #68 | ux-r0-2 | fix | nested records render as `###` in `renderPage` and `renderSectionTree` |
| #68 | ux-r0-3 | fix | `docs_read` description: "reads that section and the subsections under it" |
| #68 | ux-r0-4 | fix | `splitSiteRecords` error names the likely causes and the fix |
| #77 | code-r0-1 | comment fix; github.ts wording **declined** here | `ref` comment in `config.ts` and the `repos` comment in `docs-sources.yaml` say branch only. Widening `githubJson`'s not_found wording is in `src/upstreams/github.ts`, which #79 owns; noted in the PR for #79 |
| #77 | code-r0-2 + ux-r0-1 | fix | `possibly_stale` describe lists all three rules; spec #56 §6 matches |
| #77 | ux-r0-2 | fix | per-input warnings start with `Docs under <url prefix of their pages>` (`inputPagesUrl`) |
| #77 | ux-r0-3 | fix | measured (10,604 bytes); per-input `commit.url` dropped (→ 9,029); a test bounds `bioc://about` at 12,288 bytes |
| #77 | ux-r0-4 | fix | `.describe()` on the about dataset fields; about route and resource descriptions mention bundled datasets |
| #77 | ux-r0-5 | fix | AGENTS.md `docs:build`/`docs:record` line says they call the GitHub API and how to pass a token |
| #77 | ux-r0-6 | fix | `docs_read` description says the result carries `as_of`, `source_commit` and `freshness` |

## Non-goals

- No new capability, module, resource, prompt, upstream or recorded fixture. No MCP tool or REST
  route is added or renamed. Input schemas change only in one `describe()` string
  (`DocsSearchInputSchema.query`).
- No ranking change. `DOCS_INDEX_OPTIONS`, `QUERY_STOP_WORDS`, `MAX_SEARCH_TERMS`,
  `SUPERSEDED_ADR_BOOST` and which records are ranked stay as they are; heading-only records stay
  in the ranking (#68 ux-r0-1's alternative of dropping them would change ranking and need eval
  before/after). `npm run eval:docs` scores do not change.
- No change to the build output: `test/docs-index/__snapshots__/build-summary.json` and
  `test/fixtures/docs/` stay byte-identical.
- No edits to `src/upstreams/*`, `src/core/pkg/*`, `src/core/ops/*`, `README.md` or
  `CONTRIBUTING.md`. The misleading "this server has no GITHUB_TOKEN" wording that a build script
  can surface (#77 ux-r0-5) lives in `src/upstreams/github.ts`; the PR notes it for #79 and this
  bundle only fixes the AGENTS.md side.
- `renderPage` does not invent a heading for an h2 that has no record of its own (the `Routes` h2
  of `bioc-registry/docs/api.md`, say); its h3s render as `###` directly after the previous
  section.
- `docs_search`'s description is not reworded.

## Design

### Files

```
scripts/docs-eval/run.ts           #58: DocsSearchDataSchema.parse
scripts/docs-index/site.ts         #68 code-r0-2 (from = 1), code-r0-3 (destructure), ux-r0-4 (error hint)
scripts/docs-index/config.ts       #77 code-r0-1: ref comment
docs-sources.yaml                  #77 code-r0-1: repos comment (comment lines only)
src/docs-index/load.ts             #62 ux-r0-2: ignoredSearchTerms()
src/core/docs/search.ts            #62 ux-r0-2 (query describe, summary line); #68 ux-r0-1 (snippetSource)
src/core/docs/pages.ts             #68 ux-r0-2: renderSection level; renderSectionTree; renderPage
src/core/docs/read.ts              #68 ux-r0-3 + #77 ux-r0-6: description
src/core/docs/freshness.ts         #77: possibly_stale describe; inputPagesUrl(); warning texts; commitUrl removed
src/core/docs/index.ts             #77 ux-r0-3: no commit.url
src/core/about.ts                  #77 ux-r0-3 (no url), ux-r0-4 (describes)
src/transports/rest.ts             #77 ux-r0-4: /api/v1/about description (one string)
src/transports/mcp.ts              #77 ux-r0-4: bioc://about description (one string)
AGENTS.md                          #77 ux-r0-5: one sentence on the docs:build/docs:record line
docs/specs/3-docs-index.md         config comment; ignoredSearchTerms
docs/specs/4-docs-module.md        query describe; snippet source; rendering levels; docs_read description; test rows
docs/specs/5-docs-eval.md          run.ts parse
docs/specs/45-followups-docs.md    chunk.test row wording
docs/specs/56-docs-freshness.md    §6 describe, warning texts, inputPagesUrl, no commitUrl; §9 no url; test plan
docs/specs/61-docs-ranking.md      splitSiteRecords from line 1, error text, site.test and load.test rows
test/docs-index/load.test.ts       superseded section records; ignoredSearchTerms
test/docs-index/site.test.ts       heading equal to parent; error hint; destructure has no test of its own
test/core/docs/chunk.test.ts       rename + new case
test/core/docs/search.test.ts      describe, ignored-words line, heading-only snippet, warning texts
test/core/docs/pages.test.ts       ### levels
test/core/docs/read.test.ts        ### levels, warning texts, description
test/core/docs/resources.test.ts   ### levels
test/core/docs/freshness.test.ts   warning texts, inputPagesUrl, no commitUrl, describe
test/core/docs/index.test.ts       commit keys, warning texts
test/core/about.test.ts            no url; size bound; describes in OpenAPI
test/transports/rest.test.ts       about route description
test/transports/mcp.test.ts        about resource description
```

### #58 code-r0-1: no unchecked cast in the eval (`scripts/docs-eval/run.ts`)

Import `DocsSearchDataSchema` alongside `docsSearchCapability` from `../../src/core/docs/search`
and replace line 55:

```ts
const data = DocsSearchDataSchema.parse(result.envelope.data);
```

`DocsSearchDataSchema.parse` throws a `ZodError` if `docs_search` ever returns a different
shape; a rename of `hits` or `url` in the schema breaks `tsc` at `data.hits.map((hit) => hit.url)`.
Nothing else in `runDocsEval` changes. Spec #5's bullet "Otherwise `top_urls` is
`envelope.data.hits.map(…)`" becomes "Otherwise `top_urls` is
`DocsSearchDataSchema.parse(envelope.data).hits.map((hit) => hit.url)`".

### #62 code-r0-1: the chunk test says what it shows (`test/core/docs/chunk.test.ts`)

- Rename the existing case `'prefers a newline over a later space'` to
  `'cuts at a newline where the space fallback would cut earlier'`. Body and comment unchanged.
- Add after it:

```ts
it('prefers a newline over a later space', () => {
  // hard = 9, half = 4; newline at 5, space at 7: a last-break-of-either rule would give end 8
  expect(chunkText('aaaaa\nb cdddddd', 0, 10)).toEqual({ text: 'aaaaa\n', end: 6 });
});
```

`chunkText` is unchanged. Spec #4's `chunk.test.ts` row keeps "(preferred over a later space)",
which is now tested. Spec #45's `chunk.test.ts` row: replace `New case "prefers a newline over a
later space"` with `New case "cuts at a newline where the space fallback would cut earlier"
(renamed by #80, which added the later-space case)`.

### #62 ux-r0-2: say which query words were not searched

`src/docs-index/load.ts`, after `boundedQuery`:

```ts
/**
 * The distinct lower-cased terms of `query` that are not stop words, after the first MAX_SEARCH_TERMS of them,
 * in query order: the words search() leaves out. [] for a query with at most MAX_SEARCH_TERMS such terms.
 */
export function ignoredSearchTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const token of tokenize(query)) {
    const term = token.toLowerCase();
    if (term !== '' && !QUERY_STOP_WORDS.has(term)) terms.add(term);
  }
  return [...terms].slice(MAX_SEARCH_TERMS);
}
```

This uses the same tokenizer, lower-casing and stop words as `boundedQuery`, so whenever the
query has a non-stop term, the 16 terms `boundedQuery` keeps followed by `ignoredSearchTerms(query)`
are all the query's distinct non-stop terms. `boundedQuery` and `DocsIndex.search` are unchanged.
Spec #3's `load.ts` block lists `ignoredSearchTerms` with this doc comment after `MAX_SEARCH_TERMS`.

`src/core/docs/search.ts`:

1. The `query` field's describe becomes, exactly:

   ```ts
   .describe(
     'Words to search for, e.g. "why does the registry poll". Common words such as "the" and "why" are skipped, ' +
       'and only the first 16 other distinct words are searched, so put the key words first',
   ),
   ```

   (`min`, `max`, `regex` unchanged. A describe change keeps input and output JSON Schemas equal
   for `validateRegistry`.)

2. In the handler, `const ignored = ignoredSearchTerms(q);` once, passed to every
   `describeHits` call as a new parameter after `query`:

   ```ts
   function describeHits(
     query: string,
     ignored: readonly string[],
     source: string | undefined,
     hits: DocsSearchData['hits'],
     omitted: number,
     inputs: readonly DocsInput[],
     freshness: DocsFreshness,
   ): string
   ```

   With

   ```ts
   const skipped =
     ignored.length === 0
       ? ''
       : `\nOnly the first ${MAX_SEARCH_TERMS} distinct words were searched (common words such as "the" and "why" are skipped); not searched: ${ignored.join(' ')}. Put the key words first.`;
   ```

   the no-hits branch returns `` `No docs sections match "${query}"${where}. Try other words${…}. For live package state use pkg_status; for open issues or failing workflows use ops_activity.${skipped}${stale}` ``
   and the hits branch returns `` `${n} docs section${…} for "${query}"${where}:${lines.join('')}${skipped}${built}${stale}${dropped}` ``.
   Import `ignoredSearchTerms` and `MAX_SEARCH_TERMS` from `../../docs-index/load`.

`data` is unchanged: no output schema change. The line adds at most ~330 bytes (the query is at
most 256 characters); the size guard already drops hits if needed.
Spec #4's `DocsSearchInputSchema` snippet gets the new `query` describe, and its `docs_search`
summary step gets the `skipped` line in the positions above.

### #68 code-r0-1: superseded boost on section records (`test/docs-index/load.test.ts`)

In `describe('superseded ADRs')`, add a `section` helper next to `adr`:

```ts
const section = (n: string): DocsRecord => ({
  id: `site:adr/${n}.html#decision`,
  url: `https://docs.test/adr/${n}.html#decision`,
  title: 'Hash the addresses',
  section: 'Decision',
  crumbs: [],
  text: 'Decision\nHash the addresses at the edge.',
  source: 'adr',
});
```

and a case `'scores the section records of a superseded ADR SUPERSEDED_ADR_BOOST times as high
too'`: `syntheticDocsIndex([adr('0001', 'Superseded by 0002'), section('0001'), adr('0002',
'Accepted by 0002'), section('0002')])`, `search('hash addresses')`, find the two `#decision` hits
by id, and `expect(old.score).toBeCloseTo(current.score * SUPERSEDED_ADR_BOOST, 9)`. A boost
keyed on the full id (`superseded.has(id)`) gives ratio 1 and fails it. `load.ts` is unchanged.
The existing page-level case stays as it is.

### #68 code-r0-2, code-r0-3, ux-r0-4: `scripts/docs-index/site.ts`

- `siteSubsections`, line 65: replace the double cast with

  ```ts
  const id = match[1]!;
  const level = match[2]!;
  const inner = match[3]!;
  ```

  (the regex has three capture groups, none optional, so all three are defined on a match).
- `splitSiteRecords`, line 102: `let from = 1;` with the comment
  `// line 0 is the h2's own heading (search.json section text starts with it)`. The doc comment's
  last sentence becomes: `Throws Error naming the record id, the subsection id and the heading when
  no line of the parent's text after its first line (and after the previous cut) equals the heading.`
- The error, exactly:

  ```ts
  throw new Error(
    `${record.id}: no line "${sub.heading}" for subsection #${sub.id} in search.json text ` +
      '(search.json and the page HTML may come from different site deploys; re-run, or re-record both with npm run docs:record)',
  );
  ```

Build output is unchanged (Verified: no current cut is at line 0).

Spec #61, the `splitSiteRecords` bullet "find the first index `i` at or after the previous cut + 1"
becomes "find the first index `i` at or after the previous cut + 1, starting at line 1 (line 0 is
the h2's own heading, so an h3 named like its h2 does not cut there)", and the error text in that
bullet gets the parenthesised hint above.

### #68 ux-r0-1: snippets for heading-only records (`src/core/docs/search.ts`)

Add, below `snippet`:

```ts
/**
 * The text a hit's snippet is cut from: the record's text, or, when that is only the record's heading (an h2 whose
 * content is all in h3 subsections), the record's text and its subsections' texts joined by '\n'.
 */
function snippetSource(pages: DocsPages, record: DocsRecord): string {
  if (record.text.trim() !== record.section) return record.text;
  const page = pages.pageOf(record)!;
  return [record, ...subsectionsOf(page, record)].map((r) => r.text).join('\n');
}
```

In the handler, `snippet: snippet(snippetSource(pages, record), q)`. Move
`const pages = docsPages(index);` above the `hits` map if it is not already. Import
`subsectionsOf` and `type DocsPages` from `./pages`.

A page-level record with `section === ''` and empty text also takes the second branch, but
`subsectionsOf` returns `[]` for it, so the result is its own text: no change. A record's ranking,
`url`, `section` and `score` are unchanged. The `snippet` describe ("About 200 characters of the
section around the first query word") stays right: `docs_read` of that URL returns the same
subsections.
Spec #4's `docs_search` handler step for `snippet` says it is cut from `snippetSource(pages, record)`.

### #68 ux-r0-2: nested records render one level deeper (`src/core/docs/pages.ts`)

```ts
/** '<## or ###> <label>\n\n<url>\n\n<body>' (an empty body leaves the URL line last); `level` 3 for a nested record. */
export function renderSection(record: DocsRecord, level: 2 | 3 = 2): string {
  return withBody(`${'#'.repeat(level)} ${sectionLabel(record) || record.title}\n\n${record.url}`, body(record));
}

/** renderSection(record), then renderSection(s, 3) for each of subsectionsOf(page, record), joined by '\n\n'. */
export function renderSectionTree(page: DocsPage, record: DocsRecord): string {
  return [renderSection(record), ...subsectionsOf(page, record).map((s) => renderSection(s, 3))].join('\n\n');
}
```

In `renderPage`, the loop becomes
`for (const record of sections) parts.push(renderSection(record, record.crumbs.length > page.crumbs.length ? 3 : 2));`
and its doc comment's first line becomes
`'# <title>\n\n<page url>\n\n<page-level body>' + '\n\n' + renderSection(r, level) for every other record,`
`level 3 when r has more crumbs than the page (an h3), else 2.`

Records are at most one crumb deeper than their page (Verified), so `2 | 3` covers every record.
Effect on the fixture corpus: 161 records (117 site, 44 repo) render as `###` in whole-page reads
and `bioc://docs/` resources; section reads render their subsections as `###`. A section read of
an h3 record renders that record as `##` (it is the root of the read). Each `###` adds one byte;
`docs_read` sizes its budget from the envelope, so paging still fits.

Spec #4 "Rendering" paragraph: `renderSection(r, level = 2)` =
`` `${'#'.repeat(level)} ${sectionLabel(r) || r.title}\n\n${r.url}\n\n${body(r)}` ``, and
`renderPage` uses `level` 3 for records with more crumbs than the page. Spec #61's
`renderSectionTree` doc comment gets `renderSection(s, 3)`.

### #68 ux-r0-3 and #77 ux-r0-6: `docs_read` description (`src/core/docs/read.ts`)

The `description` becomes, exactly:

```ts
'Read the full text of one Bioconductor infrastructure docs page or section, as Markdown with ' +
  'links. Pass a url from docs_search: a url with #anchor reads that section and the subsections under it, ' +
  'a url without one reads the whole page. A record id or a bioc://docs/ URI also works. Long text comes in ' +
  'parts: call again with cursor set to next_cursor. Reads only the docs index bundled with this server and ' +
  'never fetches a URL, so a URL that is not in the index returns not_found with close matches. To find a ' +
  'page, use docs_search. For live package state use pkg_status; for open issues, pull requests or ' +
  'failing workflows use ops_activity. The result carries as_of, source_commit and freshness (index build ' +
  'date and any reason the page may be out of date).',
```

Spec #4's quoted description is replaced with the same text.

### #77 code-r0-1: `ref` is a branch

- `scripts/docs-index/config.ts:16`: the comment becomes
  `// a branch without "/" (the build looks up its head with GET /repos/seandavi/<repo>/branches/<ref>)`.
  The regex is unchanged.
- `docs-sources.yaml`: in the comment block above `repos:`, after the line
  `# reads only seandavi/* repos.`, add:

  ```yaml
  # Each ref must be a branch: the build looks up its head with GET /repos/seandavi/<repo>/branches/<ref>,
  # so a tag fails with not_found.
  ```

  No key or value changes; the build and its fixtures are unaffected.
- Spec #3's config snippet comment (line 226) gets the same wording as `config.ts`.
- **Declined here:** widening the not_found message of `githubJson` in `src/upstreams/github.ts`
  to mention a branch. That file belongs to #79's bundle; the PR body lists it as a suggestion for
  #79 rather than editing it.

### #77 code-r0-2, ux-r0-1, ux-r0-2: freshness wording (`src/core/docs/freshness.ts`)

Add, above `inputStaleWarning`:

```ts
/**
 * The URL every page built from `input` starts with: for a raw.githubusercontent.com file, its GitHub blob URL
 * (https://github.com/<owner>/<repo>/blob/<ref>/<path>, as scripts/docs-index/markdown.ts links it); otherwise the
 * directory of the input URL (the site root for search.json).
 */
export function inputPagesUrl(input: DocsInput): string {
  const url = new URL(input.url);
  const segments = url.pathname.split('/').slice(1);
  if (url.hostname === 'raw.githubusercontent.com' && segments.length >= 4) {
    const [owner, repo, ref, ...path] = segments;
    return `https://github.com/${owner}/${repo}/blob/${ref}/${path.join('/')}`;
  }
  return new URL('./', url).href;
}
```

The two per-input warnings in `inputStaleWarning` become, exactly (`<date>` is the first 10
characters of an ISO string, `<sha7>` the first 7 of a sha):

- BEHIND: `` `Docs under ${inputPagesUrl(input)} come from ${commit.repo}@<sha7>, but ${commit.ref} was already at <head_sha7> (committed <head_committed_at date>) when the index was built; they may lag ${commit.ref}.` ``
- UNKNOWN: `` `Docs under ${inputPagesUrl(input)} are ${days} days old (as of <as_of date>) and their source commit is unknown.` ``

Rules, thresholds and INDEX_WARNING are unchanged. A hit's `url` (and a `docs_read` result's
`url`) starts with the prefix named in its input's warning (Verified on every fixture record), so
an agent can match a warning to hits by URL.

`DocsFreshnessSchema.possibly_stale` describe, exactly:

```ts
.describe(
  'Why this result may be out of date: the index is 2+ days old, a source was behind its branch, or a ' +
    "source's commit is unknown and it is 14+ days old. A source's warning starts with the URL its pages " +
    'start with; [] when none',
),
```

Remove `commitUrl` (its only caller, `src/core/docs/index.ts`, no longer needs it; see below) and
its `describe('commitUrl')` test.

Spec #56 §6: the `possibly_stale` snippet, the BEHIND and UNKNOWN texts, `inputPagesUrl` added to
the exported list, `commitUrl` removed from it; the test-plan bullet for `freshness.test.ts`
drops `commitUrl` and adds `inputPagesUrl`.

### #77 ux-r0-3 and ux-r0-4: `bioc://about` (`src/core/about.ts`, `src/core/docs/index.ts`, transports)

Measured: 10,604 bytes for the production modules over the fixture index, 7,051 of them the 16
docs inputs. Outcome: drop the per-input `commit.url` (derivable from `repo` and `sha`, and the
`sha` describe says how), which takes it to 9,029 bytes without losing any fact, and bound the
size in a test. `head_sha` and `head_committed_at` stay: for a repo file `head_committed_at` is the
only date of its content.

`src/core/about.ts`:

```ts
export const DatasetCommitSchema = z.object({
  repo: z.string().describe("GitHub repository, e.g. 'seandavi/bioc-infrastructure'"),
  ref: z.string().describe('Branch the input follows'),
  sha: z.string().describe('Commit the input was built from (40 hex); its page is https://github.com/<repo>/commit/<sha>'),
  head_sha: z.string().describe('Head of ref when the dataset was built; differs from sha when the input lagged its branch'),
  head_committed_at: z.string().describe('Committer date of head_sha (ISO 8601)'),
});

export const DatasetInputSchema = SourceSchema.extend({
  commit: DatasetCommitSchema.nullable().describe('Source commit of this input; null when unknown'),
  possibly_stale: z.string().nullable().describe('Why this input may be out of date; null when there is no known reason'),
});
```

In `AboutSchema.datasets` items, replace the `//` comments with describes (other fields unchanged):

```ts
built_at: z.string().describe('When the dataset was built (ISO 8601)'),
build_commit: z.string().nullable().describe("This server's commit the dataset was built from (CI's GITHUB_SHA); null when built locally"),
age_days: z.number().int().nonnegative().describe('Whole days since built_at'),
possibly_stale: z.array(z.string()).describe('Every reason the dataset or one of its inputs may be out of date; [] when none'),
```

`src/core/docs/index.ts`, the dataset's `inputs` mapping:

```ts
commit: input.commit && {
  repo: input.commit.repo,
  ref: input.commit.ref,
  sha: input.commit.sha,
  head_sha: input.commit.head_sha,
  head_committed_at: input.commit.head_committed_at,
},
```

and drop the `commitUrl` import. Spec #56 §9 snippets follow (no `url` key; key order `repo, ref,
sha, head_sha, head_committed_at`).

Descriptions, exactly:

- `src/transports/rest.ts:112`: `'Modules, tools, upstream sources and their cache TTLs, and bundled datasets and their freshness (same JSON as the bioc://about resource).'`
- `src/transports/mcp.ts:126`: `'Modules, tools, upstream sources and their cache TTLs, and bundled datasets and their freshness.'`

No other edit to either transport file. Both still serve `buildAbout(…)`, so REST and MCP stay
identical.

### #77 ux-r0-5: AGENTS.md

The Commands bullet becomes, exactly:

```markdown
- `npm run docs:build`: build it from the live docs (network). `npm run docs:record` does the same
  and re-records `test/fixtures/docs/`. Both call the GitHub API (about 14 requests); export
  `GITHUB_TOKEN` (e.g. `GITHUB_TOKEN=$(gh auth token) npm run docs:record`) to avoid the 60-per-hour
  anonymous limit. The build reads the token from the shell, not from `.dev.vars`.
```

### Upstream calls and fixtures

None. The docs module has no upstreams, and no test records or changes a fixture. New tests use
`fixtureDocsIndex()`, `fixtureDocsIndexWith()`, `syntheticDocsIndex()` and the existing app
helpers. `npm run docs:fixtures` output and the build snapshot do not change.

## Acceptance criteria

- [ ] `npm ci && npm run typecheck && npm test && npm run build` pass with no network.
- [ ] `git diff main -- test/fixtures test/docs-index/__snapshots__ eval` is empty, and
      `npm run eval:docs` prints the same recall@1, recall@5 and MRR@10 as on `main`.
- [ ] No file under `src/upstreams/`, `src/core/pkg/`, `src/core/ops/`, `README.md` or
      `CONTRIBUTING.md` is changed. The `src/transports/` diff is the two description strings.
- [ ] **#58 code-r0-1:** `scripts/docs-eval/run.ts` contains no `as {` and reads hits through
      `DocsSearchDataSchema.parse`; renaming `url` in `DocsSearchHitSchema` makes
      `npm run typecheck` fail in `run.ts` (shown in the PR, not committed).
- [ ] **#62 code-r0-1:** the chunk test has a case named `'cuts at a newline where the space fallback
      would cut earlier'` and a case `'prefers a newline over a later space'` asserting
      `chunkText('aaaaa\nb cdddddd', 0, 10)` is `{ text: 'aaaaa\n', end: 6 }`.
- [ ] **#62 ux-r0-2:** the `query` describe contains `only the first 16 other distinct words are
      searched`; `ignoredSearchTerms` returns `[]` for a 16-distinct-word query and
      `['worker', 'deploy']` for the 18-word query below; `docs_search` with that query has a
      summary containing `not searched: worker deploy. Put the key words first.`, and a query of
      16 distinct words does not contain `not searched`.
- [ ] **#68 code-r0-1:** the new superseded-section test passes, and fails when `boostDocument`
      is changed to `superseded.has(id)` (checked by hand once, stated in the PR).
- [ ] **#68 code-r0-2:** `splitSiteRecords` on a parent `section: 'Summary'`, `text:
      'Summary\nintro\nSummary\ndetail'` with one subsection `{ id: 'summary-1', heading:
      'Summary' }` gives parent text `'Summary\nintro'` and child text `'Summary\ndetail'`.
- [ ] **#68 code-r0-3:** `scripts/docs-index/site.ts` contains no `as unknown as`.
- [ ] **#68 ux-r0-1:** `docs_search` for `cloudflare account migration procedure` with `limit: 1`
      returns `…/cloudflare-account-migration.html#procedure` whose snippet starts
      `Procedure A. Prepare the new account` (not `'Procedure'` alone). No other hit's snippet
      changes (the other `search.test` expectations pass unchanged).
- [ ] **#68 ux-r0-2:** `docs_read` of `operations.html#runbooks` starts `## Runbooks` and contains
      `\n\n### Roll back the Worker\n\n`, with no `\n## Roll back`; `renderPage` of
      `propagation-gate.html` contains `\n\n### Two traps in the data\n\n` and
      `\n\n## Why the registry polls\n\n`; the `bioc://docs/operations.html` resource contains
      `\n\n### Deploy the Worker\n\n`.
- [ ] **#68 ux-r0-3 / #77 ux-r0-6:** the `docs_read` description contains `reads that section and
      the subsections under it` and ends `(index build date and any reason the page may be out of date).`
- [ ] **#68 ux-r0-4:** the missing-heading error matches `/re-record both with npm run docs:record/`
      as well as the existing `/site:p\.html#one: no line "Nowhere" for subsection #zzz/`.
- [ ] **#77 code-r0-1:** `config.ts` and spec #3 say `a branch without "/"`; `docs-sources.yaml`
      parses to the same config as before (`realConfig()` unchanged in `config.test.ts`).
- [ ] **#77 code-r0-2 / ux-r0-1:** `z.toJSONSchema(DocsFreshnessSchema).properties.possibly_stale.description`
      contains `14+ days old`; spec #56 §6 shows the same string.
- [ ] **#77 ux-r0-2:** BEHIND and UNKNOWN warnings start `Docs under `; for a repo-file input they
      name `https://github.com/seandavi/<repo>/blob/main/<file>`, for the site input
      `https://seandavi.github.io/bioc-infrastructure/`; every fixture record's `url` starts with
      `inputPagesUrl` of its input.
- [ ] **#77 ux-r0-3:** about inputs' `commit` keys are `['repo', 'ref', 'sha', 'head_sha',
      'head_committed_at']`; `commitUrl` no longer exists (`grep -rn commitUrl src test` is
      empty); `JSON.stringify(buildAbout(modules, now))` for the production `modules` is at most
      12,288 UTF-8 bytes.
- [ ] **#77 ux-r0-4:** `/api/openapi.json` gives `/api/v1/about` the new description, and its 200
      schema has descriptions on `datasets.items.properties.age_days`, `.possibly_stale`,
      `inputs.items.properties.possibly_stale` and the commit's `head_sha` and `sha`; the
      `bioc://about` resource lists the new description.
- [ ] **#77 ux-r0-5:** AGENTS.md contains `GITHUB_TOKEN=$(gh auth token) npm run docs:record`.
- [ ] Specs #3, #4, #5, #45, #56 and #61 carry the updates listed above, and nothing else in them
      changes.

## Test plan

All Vitest in Node, no network, existing helpers. Constants as in the existing files.

| File | New or changed cases |
|---|---|
| `test/docs-eval/run.test.ts` | Unchanged; its existing cases cover the parsed path (`top_urls`, ranks and metrics over the fixture index). |
| `test/docs-index/load.test.ts` | Superseded section-record case (above). `describe('ignoredSearchTerms')`: `[]` for `'why does the registry poll'`; `[]` for 16 distinct words; for `Q18 = 'registry poll webhooks gate propagation edge traffic build manifest website universe check status release download cache worker deploy'` → `['worker', 'deploy']`; repeats and stop words do not count: `ignoredSearchTerms(Q18 + ' the registry REGISTRY why')` → `['worker', 'deploy']`. |
| `test/docs-index/site.test.ts` | "does not cut at the parent's own heading line" (the `Summary` case in Acceptance). The missing-heading case also expects `/re-record both with npm run docs:record/`. |
| `test/core/docs/chunk.test.ts` | Rename and new case (above). |
| `test/core/docs/search.test.ts` | "says in the query describe that only 16 words are searched" via `z.toJSONSchema(DocsSearchInputSchema).properties.query.description`. "names the words it did not search": `Q18` → `ok`, summary contains `not searched: worker deploy. Put the key words first.`; the first 16 words alone → summary has no `not searched`. "gives a heading-only section a snippet from its subsections" (Acceptance #68 ux-r0-1). The two warning-text expectations (lines ~318 and ~332) become `Docs under https://github.com/seandavi/bioc-edge/blob/main/DATAPLANE.md come from seandavi/bioc-edge@${edgeSha.slice(0, 7)}, but main was already at bbbbbbb (committed 2026-10-20) when the index was built; they may lag main.` and `Docs under https://docs.test/ are 14 days old (as of 2026-10-22) and their source commit is unknown.` |
| `test/core/docs/pages.test.ts` | 'renders a page…' becomes "renders a page: header, page-level body, then one ## per h2 record and one ### per h3 record": `text.match(/^## /gm)` has the length of records (other than the head) with `crumbs.length === page.crumbs.length`, `text.match(/^### /gm)` the length of those with more; contains `\n\n### Two traps in the data\n\n`. The `subsectionsOf` case's `renderSectionTree(page, a)` expectation becomes `[renderSection(a), renderSection(a1, 3), renderSection(a2, 3)].join('\n\n')`. New: `renderSection(r, 3)` starts `### `. New synthetic: a page whose head has crumbs `['Top']`, an h2 record with `['Top']` and an h3 with `['Top', 'A']` → `renderPage` has `## A` and `### A1`. |
| `test/core/docs/read.test.ts` | The runbooks case asserts `\n\n### Roll back the Worker\n\n` and no `\n## Roll back`. The description case (or a new one) asserts the two #68/#77 phrases. Warning expectations at ~389 and ~401 updated to the `Docs under …` texts (the BEHIND one as a regex starting `^Docs under https:\/\/github\.com\/seandavi\/bioc-edge\/blob\/main\/DATAPLANE\.md come from seandavi\/bioc-edge@[0-9a-f]{7}, but main was already at bbbbbbb`). |
| `test/core/docs/resources.test.ts` | The runbooks/whole-page case asserts `\n\n### Roll back the Worker\n\n`; `bioc://docs/operations.html` contains `\n\n### Deploy the Worker\n\n`. |
| `test/core/docs/freshness.test.ts` | Remove `describe('commitUrl')` and its import. BEHIND and UNKNOWN exact texts become the `Docs under https://github.com/seandavi/bioc-registry/blob/main/README.md …` forms. New `describe('inputPagesUrl')`: raw file → blob URL (`…/raw.githubusercontent.com/seandavi/bioc-registry/main/docs/api.md` → `https://github.com/seandavi/bioc-registry/blob/main/docs/api.md`); `https://seandavi.github.io/bioc-infrastructure/search.json` → `https://seandavi.github.io/bioc-infrastructure/`; `https://docs.test/search.json` → `https://docs.test/`; and over `fixtureDocsIndex()`, every record's `url` starts with `inputPagesUrl(index.inputFor(record.id)!)`. New: the `possibly_stale` describe contains `14+ days old`. |
| `test/core/docs/index.test.ts` | Key-order expectation → `['repo', 'ref', 'sha', 'head_sha', 'head_committed_at']`; test name drops "and commit URL". Warning expectations at ~39 and ~52 → `^Docs under https:\/\/github\.com\/seandavi\/.+ come from seandavi\/.+@[0-9a-f]{7}, but main was already at bbbbbbb` and `Docs under https://seandavi.github.io/bioc-infrastructure/ are 14 days old (as of 2026-10-22) and their source commit is unknown.` |
| `test/core/about.test.ts` | The `commit` fixture loses `url`. New "stays under 12 KiB for the production modules": `new TextEncoder().encode(JSON.stringify(buildAbout(modules, NOW))).length` ≤ 12,288 (`modules` from `src/core/registry`; comment: `// tripwire, measured 9,029 bytes on 2026-10-22; raise it deliberately`). New "describes the dataset fields": `z.toJSONSchema(AboutSchema)` has descriptions on `datasets.items.properties.age_days`, `.possibly_stale`, and on the input `possibly_stale` and commit `sha`/`head_sha`. |
| `test/transports/rest.test.ts` | The OpenAPI test also asserts `body.paths['/api/v1/about'].get.description` equals the new rest.ts string and that the 200 schema's `datasets.items.properties.age_days.description` is `'Whole days since built_at'`. |
| `test/transports/mcp.test.ts` | The `bioc://about` case asserts the listed resource's `description` is the new mcp.ts string. |

#58 has no runtime test: the fix is a type-level guarantee. The PR shows it by temporarily
renaming `url` to `link` in `DocsSearchHitSchema`, running `npm run typecheck`, pasting the
`scripts/docs-eval/run.ts` error, and reverting (stated in the PR body, not committed).

Manual, pasted in the PR: `npm run eval:docs` on `main` and on the branch (identical scores), and
the before/after byte count of `GET /api/v1/about` from `npm run dev`
(`curl -s http://127.0.0.1:8787/api/v1/about | wc -c`).

## Risks

- **Warning text is a contract change.** `possibly_stale` strings change wording in
  `docs_search`, `docs_read` and `bioc://about`. Clients matching on `<input.url> comes from` break;
  the REST API is unstable until v1 and no consumer is known.
- **`inputPagesUrl` duplicates the build's link rule.** It mirrors `markdown.ts`'s
  `https://github.com/<owner>/<repo>/blob/<ref>/<file>` in `src/`, which cannot import `scripts/`.
  If the build's link form changes, the fixture invariant test in `freshness.test.ts` fails, which
  is the intended alarm.
- **Dropping `commit.url` removes a field** from `bioc://about` and `GET /api/v1/about`. Agents
  now build the commit link from `repo` and `sha` (the `sha` describe says how). REST is unstable
  until v1.
- **The 12,288-byte about bound can trip on growth elsewhere.** #79 or a new docs source adds
  bytes (about 400 per docs input, about 360 per upstream). The test is a tripwire; whoever trips
  it re-measures and raises it on purpose.
- **`###` in rendered text.** Clients that split `docs_read` text on `\n## ` see subsections inside
  their parent's part. That is the intended nesting. `docs_read` paging still covers the text
  exactly; offsets and cursors of pages with subsections shift by one character per `###`.
- **Heading-only snippets read across subsections.** The snippet of the six heading-only records
  can start with the parent heading followed by the first subsection's heading
  (`Procedure A. Prepare…`). That is what `docs_read` of the hit returns, so it is not misleading.
- **Shared files.** `src/transports/rest.ts` and `src/transports/mcp.ts` may also be edited by #79;
  our edit is one string each, so a conflict is trivial. `AGENTS.md` and `docs-sources.yaml` are
  edited only here.
