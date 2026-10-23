# Spec #45: Follow-ups for the docs index and docs tools (from the #3 and #4 reviews)

Issue: [seandavi/bioc-mcp#45](https://github.com/seandavi/bioc-mcp/issues/45). It bundles every
item of [#22](https://github.com/seandavi/bioc-mcp/issues/22) (the #3 review),
[#30](https://github.com/seandavi/bioc-mcp/issues/30) and
[#41](https://github.com/seandavi/bioc-mcp/issues/41) (both from the #4 review). Builds on
[Spec #3](3-docs-index.md) and [Spec #4](4-docs-module.md). Project design:
[proposal-mcp.qmd](https://github.com/seandavi/bioc-infrastructure/blob/spec/mcp/proposal-mcp.qmd).
Conventions: [AGENTS.md](../../AGENTS.md).

Checked on 2026-10-22 against `main` at 41923d1 with the installed packages (minisearch 7.2.0,
zod 4.6.7), using throwaway scripts outside the repo (`npx tsx /tmp/…`) over the fixture build
(`npm run docs:fixtures`, 418 records, 56 pages). `npm test` passes on that commit (865 tests).
**Verified** marks what those scripts showed:

- **Verified:** `DocsIndex.search` already throws `RangeError` unless `limit` is a positive integer
  (`src/docs-index/load.ts:80`), and `test/docs-index/load.test.ts:46` covers 0, -1, 2.5, `NaN` and
  `Infinity`. The limit half of #22 security-r0-2 is moot.
- **Verified:** query cost grows with the number of query terms, and one-letter terms are the
  expensive ones (`prefix: true` expands each to every indexed term with that first letter).
  Average of 20 runs of `index.search(q, 10)` in Node 26 on the fixture index:
  a real 9-term question 2.2 ms; 8 distinct letters 5.7 ms; 16 distinct letters 11.2 ms;
  26 distinct letters 19.5 ms; the 256-character `'a b c … z a b c …'` (128 terms, 26 distinct)
  72 ms; 16 distinct 3-letter words 0.7 ms. `docs_search` accepts that 256-character query today.
- **Verified:** `MiniSearch.getDefault('tokenize')` is the tokenizer the index uses (no custom
  `tokenize` in `DOCS_INDEX_OPTIONS`). It returns `['Why', 'does', 'r', 'universe', 'poll', '']`
  for `'Why does r-universe, poll?'`. Searching the distinct lower-cased tokens joined by `' '`
  gives the same ids and scores as the raw query for all 13 queries the tests use (the ranking
  questions, the load tests, `'Why Does THE registry poll?'`). `search('---')` and `search('')`
  both return `[]`.
- **Verified:** `miniSearch.has(id)` exists in minisearch 7.2.0 (`dist/es/index.d.ts:1065`).
- **Verified:** `new URL('https://../x').hostname` is `'..'`, so a hostname can also walk out of
  the fixture root. `new URL('…/seandavi/x/..%2F..%2Fx').pathname` keeps `..%2F..%2Fx` as one
  segment, which `decodeURIComponent` turns into `../../x`. The URL parser already folds `%2e%2e`
  segments away. `new Request()` accepts both URLs.
- **Verified:** `chunkText('aaaaaa bb\nccc dddd', 0, 12)` returns `{ text: 'aaaaaa bb\n', end: 10 }`
  (hard = 11, half = 5; the space fallback would give end 7). The existing test's comment is
  wrong as #30 code-r0-1 says (hard = 10, half = 5).
- **Verified:** `pagePreamble` cuts all 13 ADR pages and no site or repo page on the fixture
  corpus. For each ADR the first section body occurs exactly once in the page-level body
  (`indexOf === lastIndexOf`).
- **Verified:** the largest `docs_read` envelope with empty `text` (the "skeleton" below) on the
  fixture corpus is 1,235 bytes, so the text budget stays 5,500 for every fixture page and section.
  Behaviour on the fixture corpus does not change.
- **Verified:** with page URLs as `docs_search` sources, the largest envelope over 10 sample
  queries at `limit: 10` is 8,127 bytes (today: 7,639). Hit URLs with anchors as sources would
  reach 8,844 and drop hits. That is why sources use page URLs.
- **Verified:** `curl -G --data-urlencode 'id_or_url=https://x/p.html#why'` sends `%23`.
- The longest repo name in the fixture index is 24 characters (12 repos).

## Goal

Close every item of #22, #30 and #41 in one PR. Each item below is fixed, or marked **moot** with
the evidence. None is declined. The PR body repeats this table so the three source issues can be
closed when it merges.

| Source | Id | Outcome | What changes |
|---|---|---|---|
| #22 | code-r0-2 | fix | `loadDocsIndex` checks every store id is in the MiniSearch index; tests for a renamed id and a duplicate id; spec #3 names the check |
| #22 | code-r0-3 | fix | `load.test` feeds a `javascript:` and an `http:` record URL and expects the format_version error |
| #22 | security-r0-2 | limit: moot; query: fix | limit already throws `RangeError` (load.ts:80, load.test.ts:46). `search()` now uses at most the first 16 distinct query terms |
| #22 | security-r0-3 | fix | `fixturePath` refuses `.`, `..` and segments with `/` or `\`, in the path and the hostname; `recordingFetch` checks before fetching |
| #30 | code-r0-1 | fix | chunk test comment corrected; new case where only the newline rule gives the right cut |
| #30 | code-r0-2 | fix | `docs_read` sizes its text budget from the envelope it will return |
| #30 | code-r0-3 (+ security-r0-2, ux-r1-1) | fix | the unknown-section message truncates the echoed fragment to 200 characters + `…` |
| #30 | code-r0-4 | fix | spec #4 test-plan row for `test/transports/docs.test.ts` matches the test |
| #30 | ux-r0-3 | fix | `explain-decision` step 2 reads the hit's url without its `#anchor` |
| #30 | ux-r0-4 | fix | `docs_search` and `docs_read` `sources` are the public page URLs, not `search.json` / raw files |
| #30 | ux-r0-5 | fix | the dropped-hits summary stops advising a lower limit |
| #30 | ux-r0-6 | fix | the `source` describe says `'site'` excludes ADRs |
| #30 | ux-r0-7 | fix | OpenAPI 404 description `Not found (upstream or bundled index)` |
| #30 | security-r0-3 | fix | `source` gets `.max(128)` |
| #30 | ux-r1-2 | fix | `pagePreamble` cuts at the last occurrence of the first section body, so an intro is never lost |
| #41 | ux-r0-2 | fix | `pkg_status`, `pkg_downloads` and `ops_activity` descriptions point design questions at `docs_search` (description strings only) |
| #41 | ux-r0-3 | fix | same change as #30 ux-r0-4 |
| #41 | ux-r0-4 | fix | `id_or_url` describe says to send `#` as `%23` over REST; README quickstart gets a `docs/read` line |
| #41 | ux-r0-5 | fix | README intro mentions docs search; "Infrastructure docs search is coming." goes |
| #41 | ux-r0-6 | fix | `docsNotFound` takes `via: 'tool' \| 'resource'`; resource reads get resource wording and `bioc://docs/` close matches |
| #41 | security-r0-1 | fix | same change as #30 security-r0-3 |
| #41 | security-r0-2 | fix | same change as #30 code-r0-3 |
| #41 | ux-r1-1 | fix | the docs transport test app mounts `opsModule` and asserts `ops_activity` is listed |

## Non-goals

- No new capability, module, resource, prompt, upstream or recorded fixture. No MCP tool or REST
  route is added or renamed. No output schema changes; the input schemas change only by
  `SourceFilterSchema.max(128)` and two `describe()` strings.
- No change to ranking: `DOCS_INDEX_OPTIONS` (boost, `prefix`, `fuzzy`) stays as it is. Making
  `prefix` skip one-letter terms would cut the cost further but changes scores; not part of this
  issue.
- `bioc://docs/` resources stay unbounded in size (spec #4 risk, unchanged).
- The MCP server `instructions` are not reworded: with page-URL sources, "cite `sources`" is now
  right for the docs tools.
- `pkg_status`, `pkg_downloads` and `ops_activity` get only the one description clause. The other
  bundles (#43, #44, #46) own the rest of those files.
- No other README edits. #39's README items are not in this bundle.

## Design

### Files

```
src/docs-index/load.ts              id-set check; boundedQuery(); MAX_SEARCH_TERMS; DocsIndex.search docstring
scripts/docs-index/fixtures.ts      fixturePath() refuses unsafe segments; recordingFetch() checks first
src/core/docs/pages.ts              DocsPages.pageOf(); docsPageSource(); pagePreamble lastIndexOf
src/core/docs/search.ts             SourceFilterSchema max + describe; page-URL sources; dropped-hits text
src/core/docs/read.ts               id_or_url describe; envelope-sized budget; page-URL source;
                                    docsNotFound(via) + fragment truncation; readSummary()
src/core/docs/resources.ts          docsNotFound(…, 'resource')
src/core/docs/prompts.ts            step 2 text
src/core/pkg/status.ts              description string only
src/core/pkg/downloads.ts           description string only
src/core/ops/activity.ts            description string only
src/transports/rest.ts              404 response description
README.md                           intro paragraph; one REST quickstart line
docs/specs/3-docs-index.md          brought up to date (list below)
docs/specs/4-docs-module.md         brought up to date (list below)
test/docs-index/load.test.ts        new cases
test/docs-index/fixtures.test.ts    NEW
test/core/docs/chunk.test.ts        comment fix + new case
test/core/docs/read.test.ts         sources, truncation, budget cases
test/core/docs/search.test.ts       sources, summary, max(128) cases
test/core/docs/pages.test.ts        repeated-intro case
test/core/docs/resources.test.ts    resource wording cases
test/core/docs/prompts.test.ts      step 2 assertion
test/transports/docs.test.ts        opsModule; description clause test
test/transports/rest.test.ts        404 description assertion
```

### #22 code-r0-2: store and index must hold the same ids (`src/docs-index/load.ts`)

Right after the existing `documentCount` check, add:

```ts
const missing = records.find((record) => !miniSearch.has(record.id));
if (missing) throw new Error(`Docs index and store disagree on record ids: ${missing.id} is not in the index`);
```

With the count check and unique store ids (already enforced), this makes the two id sets equal,
so `search` can never meet an index id that is absent from the store. Keep the existing
`if (record)` guard in the result loop; it is now unreachable but cheap.

### #22 security-r0-2: bound the query in the seam (`src/docs-index/load.ts`)

```ts
/** search() uses at most this many distinct query terms: each costs one prefix and one fuzzy sub-query. */
export const MAX_SEARCH_TERMS = 16;

const tokenize: (text: string) => string[] = MiniSearch.getDefault('tokenize');

/** The first MAX_SEARCH_TERMS distinct lower-cased tokens of `query`, joined by ' '. */
function boundedQuery(query: string): string {
  const terms = new Set<string>();
  for (const token of tokenize(query)) {
    const term = token.toLowerCase();
    if (term === '') continue;
    terms.add(term);
    if (terms.size === MAX_SEARCH_TERMS) break;
  }
  return [...terms].join(' ');
}
```

In `search`, after the `limit` check, compute `const q = boundedQuery(query);` and pass `q` (not
`query`) to both `miniSearch.search` calls. Lower-casing matches MiniSearch's default
`processTerm`, so scores are unchanged for any query with at most 16 distinct terms (Verified for
the test queries). Duplicate terms are dropped; MiniSearch would otherwise run each again.

`DocsIndex.search` docstring becomes:

```ts
/**
 * Ranked with DOCS_INDEX_OPTIONS.searchOptions over the first MAX_SEARCH_TERMS distinct terms of `query`;
 * at most `limit` (default 8) hits; RangeError unless `limit` is a positive integer. `filter` keeps only hits
 * whose record it accepts; applied inside the ranked search, before `limit`.
 */
```

Why 16 and not a character cap: cost follows terms, not characters, and a 256-character query
can hold 128 one-letter terms. 16 distinct one-letter terms cost about 11 ms in Node (Verified);
real questions have fewer than 10 terms. `docsNotFound` already sends at most 8 terms.
`docs_search` keeps its 256-character input limit.

### #22 security-r0-3: safe fixture paths (`scripts/docs-index/fixtures.ts`)

```ts
function fixturePath(root: string, url: URL): string {
  const segments = [url.hostname, ...url.pathname.split('/').filter(Boolean).map(decodeURIComponent)];
  for (const segment of segments) {
    if (segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\')) {
      throw new Error(`Refusing unsafe fixture path for ${url.href}: segment ${JSON.stringify(segment)}`);
    }
  }
  return join(root, ...segments);
}
```

(`''` cannot occur: `filter(Boolean)` drops empty path segments and a parsed `https:` URL has a
non-empty hostname.)

`recordingFetch` computes the path **before** calling `inner`, so an unsafe URL (for example a
redirect target that `fetchUpstream` hands back to `deps.fetch`) is refused without a request:

```ts
export function recordingFetch(inner: FetchFn, root: string): FetchFn {
  return async (request) => {
    const path = fixturePath(root, new URL(request.url));
    const response = await inner(request);
    if (response.status === 200) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, await response.clone().text());
    }
    return response;
  };
}
```

`fixtureDocsFetch` keeps calling `fixturePath` first and so also throws on an unsafe URL. Update
both docstrings: append `Throws on a URL whose hostname or decoded path segment is '.', '..' or
contains '/' or '\\'.` to `fixtureDocsFetch`'s, and `Refuses an unsafe URL (see fixtureDocsFetch)
before calling inner.` to `recordingFetch`'s.

### #30 code-r0-2: size the `docs_read` text budget from the envelope (`src/core/docs/read.ts`)

Add `type DocsReadData = z.output<typeof DocsReadDataSchema>;` and pull the summary into a helper:

```ts
function readSummary(label: string, url: string, offset: number, end: number, total: number, nextCursor: string | null): string {
  return offset === 0 && nextCursor === null
    ? `${label} (${url}), full text, ${total} characters.`
    : `${label} (${url}), characters ${offset + 1}–${end} of ${total}.` +
        (nextCursor === null ? '' : ` Call docs_read again with cursor "${nextCursor}" for the rest.`);
}
```

Handler, after the cursor check (step 3 of spec #4):

1. Compute `url`, `section`, `label` and `sources` (below) as today, before chunking.
2. Build the skeleton: the envelope this call would return with `text: ''`, `offset: full.length`,
   `total_chars: full.length`, `next_cursor: String(full.length)` and
   `summary: readSummary(label, url, full.length, full.length, full.length, String(full.length))`.
   Every other field is the real value.
3. `const budget = Math.min(DOCS_READ_TEXT_BUDGET, MAX_RESULT_BYTES - envelopeBytes(skeleton));`
4. `const { text, end } = chunkText(full, offset, budget);` and build the real envelope with
   `summary: readSummary(label, url, offset, end, full.length, nextCursor)`.

The skeleton is an upper bound on everything but `text`: no real offset, end or cursor has more
digits than `full.length + 1`, the multi-part summary is longer than the one-part one, and
`chunkText`'s budget counts exactly the JSON bytes that `text` adds between its quotes. So the
real envelope is at most `MAX_RESULT_BYTES`. On the fixture corpus the budget stays 5,500
(Verified), so every cursor and test result stays the same. If one record's metadata alone left
less than 6 bytes, `chunkText` throws `RangeError` and `invokeCapability` reports `internal`
(logged); that needs ~8 KB of title, URL and crumbs and is accepted (Risks).

Import `envelopeBytes`, `MAX_RESULT_BYTES` and `type Envelope` from `../../envelope`.

### #30 ux-r0-4 / #41 ux-r0-3: page URLs as provenance (`pages.ts`, `search.ts`, `read.ts`)

`src/core/docs/pages.ts`:

```ts
export interface DocsPages {
  // … existing fields …
  /** The page `record` belongs to (by page id); undefined for a record not in this index. */
  pageOf(record: DocsRecord): DocsPage | undefined;
}
```

Implementation in `docsPages`: `pageOf: (record) => byId.get(pageIdOf(record))`.

```ts
/** Provenance for a docs result: the page's public URL (no #anchor), dated by the input it was built from. */
export function docsPageSource(page: DocsPage): Source {
  return { url: page.url, as_of: docsSource(page.input).as_of };
}
```

`docsSource` stays (the `docs-index` dataset in `bioc://about` still lists the inputs).

- `docs_search`: `const pages = docsPages(index);` and
  `const pageSources = found.map(({ record }) => docsPageSource(pages.pageOf(record)!));`. `build(kept)`
  takes the distinct-by-`url` sources of the first `kept` entries, in hit order, exactly as it does
  today with `inputs`. Section hits on one page share one source.
- `docs_read`: `sources: [docsPageSource(page)]`, for a page and a section read alike.

So `sources[].url` is always something `docs_read` resolves and a person can open. The
`search.json` and raw-file URLs remain visible in `bioc://about` (`datasets[0].inputs`).

### #30 ux-r0-5: dropped-hits summary (`src/core/docs/search.ts`)

In `describeHits`, the `dropped` line becomes, exactly:

```ts
`\n${omitted} more hit${omitted === 1 ? ' was' : 's were'} dropped to stay under 8 KB; they rank below these. Narrow with source or more specific words to see others.`
```

### #30 ux-r0-6 and security-r0-3 / #41 security-r0-1: `SourceFilterSchema`

```ts
const SourceFilterSchema = z
  .string()
  .max(128)
  .regex(/^(site|adr|repo:[A-Za-z0-9._-]+)$/, "source must be 'site', 'adr' or 'repo:<name>'")
  .describe(
    "Narrow to 'site' (the infrastructure site's pages other than ADRs), 'adr' (architecture decision records) or 'repo:<name>' (one bioc-* repo's docs, e.g. 'repo:bioc-registry')",
  );
```

Full `docs_search` input schema after the change (output schemas unchanged; see
`src/core/docs/search.ts` and spec #4):

```ts
export const DocsSearchInputSchema = z.object({
  query: z.string().min(1).max(256).regex(/\S/, 'query must contain a non-space character')
    .describe('Words to search for, e.g. "why does the registry poll"'),
  limit: z.number().int().min(1).max(10).default(8).describe('Maximum number of sections to return (1–10)'),
  source: SourceFilterSchema.optional(),
});
```

`.max()` keeps input and output JSON Schemas identical, so `validateRegistry`'s idempotence check
still passes. A rejected `source` is reported by `invokeCapability` as `invalid_input` with zod's
message, which does not repeat the value. MCP tool `docs_search`, REST `GET /api/v1/docs/search`:
unchanged.

### #41 ux-r0-4: `id_or_url` describe and README (`src/core/docs/read.ts`)

```ts
export const DocsReadInputSchema = z.object({
  id_or_url: z
    .string()
    .min(1)
    .max(MAX_DOCS_REFERENCE_LENGTH)
    .describe(
      'A url from docs_search (with #anchor for one section, without for the whole page), a record id ' +
        "('site:propagation-gate.html#why-the-registry-polls'), or a bioc://docs/ resource URI; over REST, send '#' as %23",
    ),
  cursor: /* unchanged */,
});
```

MCP tool `docs_read`, REST `GET /api/v1/docs/read`: unchanged; the OpenAPI parameter description
picks up the new text.

README, REST quickstart: add after the `docs/search` line:

```sh
curl -s -G "$BIOC_MCP/api/v1/docs/read" --data-urlencode 'id_or_url=https://seandavi.github.io/bioc-infrastructure/propagation-gate.html#why-the-registry-polls'
```

### #41 ux-r0-5: README intro

Replace lines 7–11 with exactly:

```markdown
**A public, read-only [Model Context Protocol](https://modelcontextprotocol.io) server, and the
equivalent REST API, for Bioconductor.** Connect an AI agent (Claude, Codex, Gemini, …) to one URL
and it can check a package's build and propagation state, read why a check failed, see release
dates and downloads, see what is happening across the `bioc-*` repos, and search the
infrastructure docs and ADRs for why it works that way, with every answer linked to the public
source it came from.
```

### #30 code-r0-3 (+ security-r0-2, ux-r1-1) / #41 security-r0-2 and ux-r0-6: `docsNotFound`

New signature (the parameter is required; there is one spelling per caller):

```ts
/** The not_found error for a missing target, with up to 5 close matches from the index, worded for a docs_read call or a bioc://docs/ resource read. */
export function docsNotFound(
  index: DocsIndex,
  pages: DocsPages,
  input: string,
  target: Extract<DocsTarget, { kind: 'missing' }>,
  via: 'tool' | 'resource',
): CapabilityError;
```

`read.ts` passes `'tool'`; `resources.ts` passes `'resource'`. Add a private helper and use it for
every echo of caller text:

```ts
/** Caller text as echoed in an error: at most SHOWN_LENGTH characters, then '…'. */
function truncateEcho(text: string): string {
  return text.length > SHOWN_LENGTH ? text.slice(0, SHOWN_LENGTH) + '…' : text;
}
```

Close-match searches are unchanged (`closeMatchTerms`, `CLOSE_MATCHES`). Messages, exactly
(`frag = truncateEcho(fragment)`, `shown = truncateEcho(input)`, `sections` and `matches` computed
as today):

| Branch | `via` | Message |
|---|---|---|
| known page, unknown section | `tool` | `` `No section "#${frag}" on ${page.url}. Sections on that page include: ${sections.map((r) => r.url).join(', ')}. docs_read reads only the docs index and never fetches URLs.` `` |
| known page, unknown section | `resource` | `` `No section "#${frag}" in ${page.uri}. Sections in that page include: ${sections.map((r) => page.uri + new URL(r.url).hash).join(', ')}.` `` |
| no page | `tool` | unchanged: `` `No docs page or section matches "${shown}". docs_read reads only the docs index and never fetches URLs; pass a url from docs_search, a record id or a bioc://docs/ URI.` `` + `` ` Close matches: ${matches.join(', ')}.` `` or `' Use docs_search to find one.'` |
| no page | `resource` | `` `No docs page at ${shown}.` `` + `` ` Close matches: ${uris.join(', ')}; or use docs_search to find one.` `` or `' Use docs_search to find one.'` |

For the resource no-page branch, `uris` are the distinct `pages.pageOf(hit.record)!.uri` of the
same `index.search(words.join(' '), CLOSE_MATCHES)` hits, in hit order. A resource reader gets
URIs it can read, and `page.uri + hash` section URIs resolve through the `{+path}` template
(spec #4, Verified there).

The resource read's existing "longer than 2,048 characters" message is unchanged. The MCP
transport keeps mapping `not_found` to `ResourceNotFoundError` (-32602).

### #30 ux-r0-3: `explain-decision` step 2 (`src/core/docs/prompts.ts`)

Step 2 becomes, exactly:

```ts
"2. Call docs_read with the most relevant hit's url without its #anchor, which reads the whole ADR (status, context, decision, consequences). Read further hits only if the first does not settle the question.",
```

Steps 1, 3 and 4 are unchanged.

### #30 ux-r1-2: `pagePreamble` (`src/core/docs/pages.ts`)

Change `pageBody.indexOf(first)` to `pageBody.lastIndexOf(first)`. The cut point can only move
later: if the first section body also appears in the intro, the intro is kept; if it also appears
in a later section, some section text shows twice. Duplication is the safer failure than losing
text. On the fixture corpus the cut is the same for all 13 ADRs (Verified). Extend the
`renderPage` docstring's last sentence to: `…is cut where the first section's body last starts,
which keeps the 'Status:' and 'Date:' lines and never drops intro text that repeats it.`

### #41 ux-r0-2: routing design questions to `docs_search`

Append one sentence to each of these `description` strings, after its last sentence and a space,
exactly: `For why or how the infrastructure works this way (design, ADRs, runbooks) use docs_search.`

- `src/core/pkg/status.ts` (`pkg_status`), after `…versions use pkg_release_info.`
- `src/core/pkg/downloads.ts` (`pkg_downloads`), after `…for release versions use pkg_release_info.`
- `src/core/ops/activity.ts` (`ops_activity`), after `…Does not report host, service or traffic health.`

No other edit to those files. #45's body names `pkg_status` and `ops_activity`; the #41 finding
also names `pkg_downloads` ("how are downloads counted" is its example, and
`download-stats.html` is in the docs), so it gets the same one-sentence edit.

### #30 ux-r0-7: OpenAPI 404 (`src/transports/rest.ts`)

`404: json(ErrorBodySchema, 'Not found (upstream or bundled index)'),`

### Specs brought up to date

`docs/specs/3-docs-index.md`:

1. `DocsIndex` interface block: `search(query: string, limit?: number, filter?: (record: DocsRecord) => boolean)`
   with the new docstring; add `export const MAX_SEARCH_TERMS = 16;`.
2. `loadDocsIndex` step 2 unchanged; step 3 adds "and that every store id is in the index
   (`miniSearch.has`), else `Error('Docs index and store disagree on record ids: <id> is not in the index')`".
   Step 4: "search over `boundedQuery(query)` (the first 16 distinct lower-cased tokens of
   MiniSearch's default tokenizer)"; replace "(skip ids missing from the store, which step 3 rules out)"
   with "(step 3 makes every id present)".
3. Fixture fetches: the path rule and the refusal (hostname and decoded segments; `.`, `..`, `/`,
   `\`), and that `recordingFetch` checks before calling `inner`.
4. Acceptance: the `loadDocsIndex` throws bullet adds "a renamed record id, a duplicate record id,
   and a non-https record URL".
5. Test plan: `load.test.ts` row adds those cases and the term bound; new
   `test/docs-index/fixtures.test.ts` row.

`docs/specs/4-docs-module.md`:

1. `SourceFilterSchema` snippet and `DocsReadInputSchema` describe as above.
2. `pages.ts` block: `pageOf` on `DocsPages`, `docsPageSource`, and the `renderPage` docstring.
3. `docs_search` handler step 5: sources are `docsPageSource` of each hit's page, distinct by URL,
   hit order. Step 6: the new dropped-hits sentence.
4. `docsNotFound` paragraph: the `via` parameter, `truncateEcho` on both branches, the message
   table above.
5. `docs_read` handler: steps 4, 6 and 7 as in the code-r0-2 section (skeleton budget,
   `docsPageSource(page)`, `readSummary`).
6. `resources.ts`: `docsNotFound(…, 'resource')`.
7. `prompts.ts` snippet: the new step 2.
8. Acceptance: "`sources` are the distinct inputs of the hits…" becomes "`sources` are the
   distinct page URLs of the hits, with `as_of` from each page's input".
9. Test plan, `test/transports/docs.test.ts` row: `makeTestApp({ extraModules: [pkgModule, opsModule, await docsTestModule()] })`;
   prompts present on `/mcp/docs` and `/mcp`, absent on `/mcp/pkg`, `/mcp/meta` and
   `/mcp/example`; `/mcp` lists the docs tools alongside `meta_ping`, `pkg_status` and
   `ops_activity`; the description-clause test.

Do not rewrite unrelated parts of either spec.

### Upstream calls and fixtures

None. The docs module has no upstreams, and no test records or changes a fixture. New tests use
`fixtureDocsIndex()`, `syntheticDocsIndex()`, `fixtureArtifact()` and a temporary directory
(`mkdtemp`). The build snapshot (`test/docs-index/__snapshots__/build-summary.json`) does not
change, because nothing in the build changes.

## Acceptance criteria

- [ ] `npm ci && npm run typecheck && npm test && npm run build` pass with no network.
- [ ] **#22 code-r0-2:** `loadDocsIndex` throws `/disagree on record ids/` when one store record's
      id is renamed (count unchanged), and `/duplicate record id/` when one record's id is set to
      another's.
- [ ] **#22 code-r0-3:** `loadDocsIndex` throws `/format_version 1/` when `records[0].url` is
      `javascript:alert(1)`, and when it is `http://example.org/`.
- [ ] **#22 security-r0-2:** `index.search('registry ' + 'zzz '.repeat(100))` returns the same ids
      and scores as `index.search('registry zzz')`; with 16 distinct non-matching words
      (`zqxja` … `zqxjp`), `'<16 words> registry'` returns `[]` and `'registry <16 words>'`
      returns hits. The existing limit cases still throw `RangeError`.
- [ ] **#22 security-r0-3:** `recordingFetch(inner, root)` rejects `/unsafe fixture path/` for
      `https://raw.githubusercontent.com/seandavi/x/..%2F..%2Fx`, `…/x/..%5Cx` and `https://../x`,
      without calling `inner` and leaving `root` empty; `fixtureDocsFetch(root)` rejects the same
      URLs; a safe URL is written to `<root>/<host>/<path>` and read back.
- [ ] **#30 code-r0-1:** the chunk test comment says hard = 10, half = 5, and
      `chunkText('aaaaaa bb\nccc dddd', 0, 12)` equals `{ text: 'aaaaaa bb\n', end: 10 }`.
- [ ] **#30 code-r0-2:** on a synthetic page with a 1,000-character title, four 250-character
      crumbs, an ~820-character URL and 30,000 characters of text, every `docs_read` part is `ok`
      and ≤ 8,192 bytes, the parts rebuild `renderPage` exactly, and the first part's text is
      under 5,500 JSON bytes. The whole-fixture-corpus pagination test still passes unchanged.
- [ ] **#30 code-r0-3 / #41 security-r0-2:** `docs_read` with `${GATE}#${'x'.repeat(2000)}` returns
      `not_found` whose message contains `"#${'x'.repeat(200)}…"`, not `'x'.repeat(201)`, and is
      under 1,500 characters.
- [ ] **#30 code-r0-4:** spec #4's docs.test row names `[pkgModule, opsModule, await docsTestModule()]`
      and lists `/mcp/pkg`, `/mcp/meta`, `/mcp/example` as prompt-absent toolsets.
- [ ] **#30 ux-r0-3:** `explainDecisionPrompt.render(…)` contains `url without its #anchor`.
- [ ] **#30 ux-r0-4 / #41 ux-r0-3:** `docs_read` of `GATE` and of `POLLS` both give
      `sources: [{ url: GATE, as_of: <search.json fetched_at> }]`; `docs_search` `sources` are the
      distinct page URLs (`hit.url` without `#…`) of the hits in hit order, each with its input's
      `as_of`; no docs result has a `sources[].url` ending in `search.json` or starting
      `https://raw.githubusercontent.com/`.
- [ ] **#30 ux-r0-5:** the size-guard test's summary contains
      `they rank below these. Narrow with source or more specific words to see others.` and not
      `lower limit`.
- [ ] **#30 ux-r0-6:** the `source` describe contains `pages other than ADRs`.
- [ ] **#30 ux-r0-7:** `GET /api/openapi.json` documents `404` as `Not found (upstream or bundled index)`.
- [ ] **#30 security-r0-3 / #41 security-r0-1:** `source: 'repo:' + 'a'.repeat(200)` gives
      `invalid_input` whose message does not contain `'a'.repeat(200)`; `repo:bioc-registry` still
      works.
- [ ] **#30 ux-r1-2:** a synthetic page whose intro repeats the first section's short body keeps
      its intro (exact `renderPage` string below); the 13-ADR test passes unchanged.
- [ ] **#41 ux-r0-2:** `pkg_status`, `pkg_downloads` and `ops_activity` descriptions in production
      `modules` end with `(design, ADRs, runbooks) use docs_search.`; `git diff` of those three
      files touches only the description strings.
- [ ] **#41 ux-r0-4:** the `id_or_url` describe ends with `over REST, send '#' as %23`; the README
      quickstart has the `curl -s -G … --data-urlencode 'id_or_url=…#why-the-registry-polls'` line.
- [ ] **#41 ux-r0-5:** `grep -n "docs search is coming" README.md` returns nothing; the intro is
      the paragraph above.
- [ ] **#41 ux-r0-6:** resource `read('bioc://docs/nope.html')` throws `not_found` starting
      `No docs page at bioc://docs/nope.html.` and containing `docs_search` but not
      `docs_read reads only`; `read('bioc://docs/propagation-gates.html')` lists
      `bioc://docs/propagation-gate.html`; `read('bioc://docs/propagation-gate.html#nope')` starts
      `No section "#nope" in bioc://docs/propagation-gate.html.` and every listed URI reads without
      throwing. `docs_read`'s tool messages are unchanged apart from the truncation.
- [ ] **#41 ux-r1-1:** `test/transports/docs.test.ts` `testApp()` mounts `opsModule`, and the
      `/mcp` test is named and asserts `…alongside meta_ping, pkg_status and ops_activity`.
- [ ] Specs #3 and #4 carry the updates listed above.

## Test plan

All Vitest in Node, no network, existing helpers. Constants as in the existing files
(`BASE`, `GATE`, `POLLS`).

| File | New or changed cases |
|---|---|
| `test/docs-index/load.test.ts` | (1) "throws when a store id is not in the index": `records = artifact.store.records.map((r, i) => (i === 0 ? { ...r, id: 'site:renamed.html' } : r))` → `/disagree on record ids/`. (2) "throws on a duplicate record id": `records[1] = { ...records[1], id: records[0].id }` → `/duplicate record id/`. (3) `it.each(['javascript:alert(1)', 'http://example.org/'])` "rejects a record url %s": `records[0].url = url` → `/format_version 1/`. (4) "uses at most 16 distinct query terms": the three assertions in Acceptance (compare `hits.map((h) => [h.record.id, h.score])`). Build each modified store as `{ ...artifact.store, records }` and load it with `indexJson: artifact.indexJson`. |
| `test/docs-index/fixtures.test.ts` (new) | `mkdtemp(join(tmpdir(), 'docs-fixtures-'))` in `beforeEach`, `rm(root, { recursive: true, force: true })` in `afterEach`. `it.each` over the three unsafe URLs: `inner = vi.fn(async () => new Response('x'))`; `recordingFetch(inner, root)(new Request(url))` rejects `/unsafe fixture path/`; `inner` not called; `readdir(root)` is `[]`; `fixtureDocsFetch(root)(new Request(url))` rejects the same. Safe case: `recordingFetch` over `https://docs.test/a/b.md` with `inner` answering 200 `'hello'` writes `<root>/docs.test/a/b.md`; `fixtureDocsFetch(root)` returns 200 `'hello'` with `content-type: text/plain`. |
| `test/core/docs/chunk.test.ts` | Fix the comment in 'cuts after the last newline in the second half' to `// hard = 10 ('aaaa\nbbbb\n' costs 12), half = 5; last \n in [5, 10) is at 9`. New case "prefers a newline over a later space": `chunkText('aaaaaa bb\nccc dddd', 0, 12)` → `{ text: 'aaaaaa bb\n', end: 10 }` with comment `// hard = 11, half = 5; the space at 6 would give end 7`. |
| `test/core/docs/read.test.ts` | 'gives the input source provenance' becomes "cites the page url, dated by its input": `GATE` and `POLLS` both give `[{ url: GATE, as_of: index.meta.inputs[0]!.fetched_at }]`; a repo document gives its `https://github.com/…/blob/main/…` page url. Extend 'truncates a long input' with the 2,000-character fragment case. New `describe('budget')` "fits a page with very long metadata": `syntheticDocsIndex([{ id: 'site:big.html', url: \`https://docs.test/${'u'.repeat(800)}.html\`, title: 'T'.repeat(1000), section: '', crumbs: Array.from({ length: 4 }, () => 'C'.repeat(250)), text: 'word '.repeat(6000).trim(), source: 'site' }])`; read `site:big.html` following `next_cursor`, assert each `ok`, `envelopeBytes ≤ MAX_RESULT_BYTES`, rebuilt text equals `renderPage(docsPages(idx).list[0]!)`, and `jsonBytes(first.text) < DOCS_READ_TEXT_BUDGET` (`jsonBytes` as in chunk.test). |
| `test/core/docs/search.test.ts` | 'lists distinct sources with as_of from the input' becomes "lists the distinct page urls of the hits": `sources.map((s) => s.url)` equals the distinct `h.url.split('#')[0]` in hit order; each `as_of` equals that record's input `fetched_at`; none ends with `search.json`. Size guard: also assert the new sentence and `not.toContain('lower limit')`. Add to 'rejects %s': `['205-character source', { query: 'registry', source: 'repo:' + 'a'.repeat(200) }]`, plus a separate case asserting the message does not contain `'a'.repeat(200)`. New case: the `source` describe contains `pages other than ADRs` (read via `z.toJSONSchema(DocsSearchInputSchema).properties.source.description`). |
| `test/core/docs/pages.test.ts` | "keeps an intro that repeats the first section's body": records `{ id: 'site:z.html', url: 'https://docs.test/z.html', text: 'Status: Accepted\n\nTBD for now.\n\nTBD' }` and `{ id: 'site:z.html#a', url: 'https://docs.test/z.html#a', section: 'A', text: 'A\nTBD' }` → `renderPage` is `'# T\n\nhttps://docs.test/z.html\n\nStatus: Accepted\n\nTBD for now.\n\n## A\n\nhttps://docs.test/z.html#a\n\nTBD'`. "pageOf finds a record's page": `pages.pageOf(index.get('site:propagation-gate.html#why-the-registry-polls')!)` is `pages.byPath.get('propagation-gate.html')`. `docsPageSource` of that page is `{ url: GATE, as_of: <fetched_at> }`. |
| `test/core/docs/resources.test.ts` | Extend 'throws not_found for an unknown URI' with the `No docs page at bioc://docs/nope.html.` prefix and `not.toContain('docs_read reads only')`. New: `propagation-gates.html` lists `bioc://docs/propagation-gate.html`; `propagation-gate.html#nope` gives the section prefix, and each URI matched by `/bioc:\/\/docs\/[^\s,]+#[^\s,.]+/g` reads without throwing. |
| `test/core/docs/prompts.test.ts` | 'renders the topic and the tools to call' also expects `url without its #anchor`. |
| `test/transports/docs.test.ts` | `testApp()` → `makeTestApp({ extraModules: [pkgModule, opsModule, await docsTestModule()] })` (import `opsModule` from `../../src/core/ops`). Rename the `/mcp` test to `'/mcp lists them alongside meta_ping, pkg_status and ops_activity'` and add `'ops_activity'` to `arrayContaining`. New registry test "pkg and ops descriptions send design questions to docs_search": for `pkg_status`, `pkg_downloads`, `ops_activity` in production `modules`, the description ends with `(design, ADRs, runbooks) use docs_search.` |
| `test/transports/rest.test.ts` | The OpenAPI test asserts `item.responses['404'].description === 'Not found (upstream or bundled index)'`. |

Manual, pasted in the PR: `npm run dev`, then
`curl -s -G http://127.0.0.1:8787/api/v1/docs/read --data-urlencode 'id_or_url=https://seandavi.github.io/bioc-infrastructure/propagation-gate.html#why-the-registry-polls'`
(showing the section read and its page-URL `sources`).

## Risks

- **Page-URL sources add bytes to `docs_search`.** Each distinct page costs a ~100-byte source
  where today all site hits share one `search.json` source. The largest sample was 8,127 bytes at
  `limit: 10` (Verified), close to the limit, so some live queries at `limit: 10` will drop a hit
  or two. The size guard handles it and the summary says so. Anchored hit URLs as sources would
  have cost more (8,844).
- **Clients that relied on `sources` naming `search.json`** lose that; the index inputs stay in
  `bioc://about`. The REST API is unstable until v1.
- **The 16-term cap changes results for longer queries.** A query with more than 16 distinct terms
  is searched on its first 16. A query with repeated words scores slightly differently (duplicates
  no longer count twice). Neither shows up in the ranking tests. 16 one-letter terms still cost
  about 11 ms in Node; the cheaper fix (no prefix expansion for one-letter terms) changes ranking
  and is out of scope.
- **`lastIndexOf` can show duplicate text** on a future page whose first section body also appears
  in a later section. That is visible but loses nothing; `indexOf` could lose an intro silently.
- **The `docs_read` budget can still fail** if one record's title, URL and crumbs alone approach
  8 KB: `chunkText` then throws `RangeError` and the call is `internal`. Real titles are under
  200 characters.
- **Shared files.** `src/core/pkg/status.ts`, `src/core/pkg/downloads.ts` and
  `src/core/ops/activity.ts` are also edited by #44 and #46, and `README.md` may be edited by #39's
  follow-up. Our edits are one sentence each (and the intro and one quickstart line), so a merge
  conflict is small; whichever PR merges second resolves it.
