# Spec #4: the `docs` module (`docs_search`, `docs_read`, `bioc://docs/{path}`, `explain-decision`)

Issue: [seandavi/bioc-mcp#4](https://github.com/seandavi/bioc-mcp/issues/4). Builds on
[Spec #3](3-docs-index.md) (the index and its `DocsIndex` seam), [Spec #2](2-scaffold.md) and
[Spec #15](15-scaffold-followups.md). Project design:
[proposal-mcp.qmd](https://github.com/seandavi/bioc-infrastructure/blob/spec/mcp/proposal-mcp.qmd)
("Tools (v0)", "Resources", "Prompts", "Docs search"). Conventions: [AGENTS.md](../../AGENTS.md).

Everything marked **Verified** was checked on 2026-10-22 in this worktree (`npm ci`,
`npm run docs:fixtures`, so the index is the fixture build of 418 records from 16 inputs), using
throwaway Vitest files that were deleted afterwards:

- **Verified (corpus):** the 418 records group into **56 pages** by URL without fragment (41 site
  pages including 13 ADRs, and 15 repo files). Every page has exactly one page-level record (URL
  without `#`, `section: ''`). The largest page is `proposal-unified-search.html` (17 sections,
  37,128 bytes of JSON-escaped text). 46 of 56 pages and 11 single records are over 6,000 bytes, so
  `docs_read` must paginate both pages and sections. A page has at most 22 records.
- **Verified (corpus):** 54 non-page site records have `section: ''`, all of them ADR sections
  (`#context`, `#decision`, `#why-at-the-edge-rather-than-at-ingest`, …). Their text does not
  repeat a heading. Site records with a non-empty `section` start their `text` with that heading
  followed by `\n` (e.g. `"Why the registry polls\nr-universe emits no webhook…"`). Site text has
  runs of up to 10 `\n` where tables were flattened.
- **Verified (corpus):** repos in the index are `bioc-registry, bioc-edge, bioc-traffic, bioc-build,
  bioc-manifest, bioc-website, bioc-infrastructure, bioc-r-universe-build-db, bioc-intelligence,
  bioc-on-ice, bioc-harnesses, bioc-mcp`. Longest title 103 chars, section 140, URL 198, JSON of
  crumbs 139 bytes. In the fixture build every input has `last_modified: null`.
- **Verified (ranking, fixture index, `DOCS_INDEX_OPTIONS`):** the top hit is the expected section
  for each of the five questions under [Ranking questions](#ranking-questions), and with an `adr`
  filter `redirects` ranks ADR 0013 first and `propagation gate` ranks ADR 0011 first.
- **Verified (MiniSearch 7.2.0):** `miniSearch.search(query, { filter })` merges the per-call
  options over the constructor's `searchOptions` (`executeQuery` builds
  `{ tokenize, processTerm, ...globalSearchOptions, ...searchOptions }`), so boost/prefix/fuzzy stay
  in force. `filter` receives a `SearchResult` whose only stored field is `id` (`storeFields: []`).
  `result.terms` (matched document terms) is noisy under `prefix: true` (`how do I purge…` matches
  `it, is, in, identical, …`), so snippets anchor on the caller's query words, not on `terms`.
- **Verified (size):** with 10 hits whose snippets are 202 characters plus a summary line per hit
  (title, section, URL), the `docs_search` envelope reached **8,273 bytes** for `release`, over the
  8,192 limit. 7 of 12 broad queries exceeded 6,000 bytes. Hence `limit` max 10, 200-character
  snippets and a size guard that drops trailing hits.
- **Verified (size):** the `docs_read` envelope without its text (data fields, summary with
  six-digit offsets and a cursor, one source) is at most **1,554 bytes** over all 418 records. So a
  5,500-byte text budget leaves about 1.1 KB of headroom under 8,192.
- **Verified (`@modelcontextprotocol/server` 2.3.1, client 2.3.1, InMemoryTransport):**
  - `new ResourceTemplate('bioc://docs/{+path}', { list })` matches `bioc://docs/adr/0009-x.html`
    and `bioc://docs/repo/bioc-edge/DATAPLANE.md`. The simple form `{path}` does **not** match a
    path containing `/`.
  - `resources/list` returns the static `bioc://about` plus every listed template resource, with the
    template's `description`/`mimeType` merged under each listing.
  - `resources/templates/list` returns `{ name, title, uriTemplate: 'bioc://docs/{+path}', description, mimeType }`.
  - Throwing `new ResourceNotFoundError(uri, message)` from the read callback reaches the client
    as an error with code `-32602`, our `message`, and `data: { uri }`.
  - `registerPrompt(name, { title, description, argsSchema: z.object({ topic: z.string().min(1).describe(…) }) }, cb)`
    lists `arguments: [{ name: 'topic', description, required: true }]`. A missing argument fails
    with `-32602 Invalid arguments for prompt …`.
  - `new URL('bioc://docs/a%20b/../c.html').toString()` is `bioc://docs/c.html`: the SDK normalises
    dot segments before matching.

No new npm package is needed.

## Goal

The `docs` module, served at `/mcp`, `/mcp/docs` and `/api/v1/docs/…`, over the index #3 bundles:

- **`docs_search(query, limit=8, source?)`**: ranked sections with title, url, breadcrumb,
  snippet and score. `source` narrows to `site`, `adr` or `repo:<name>`.
- **`docs_read(id_or_url, cursor?)`**: the full text of one page or section **from the index
  only**, as Markdown, paginated with a cursor so no result exceeds 8 KB. An unknown URL returns
  `not_found` listing close matches and makes no outbound request.
- **Resources:** `bioc://docs/{+path}`, one per page (56 today), listed in `resources/list`.
- **Prompt (MCP only):** `explain-decision(topic)`: search `adr`, read, and answer with quotes
  and links.
- **`bioc://about`** (and `GET /api/v1/about`) reports the index build time, build commit and
  per-input freshness. Spec #3 deferred this to the module that bundles the index.

To support resources and prompts per module, `Module` gains optional `resources`, `prompts` and
`datasets`, and the MCP transport registers them for the selected toolset.

## Non-goals

- **No ranking change.** `DOCS_INDEX_OPTIONS` and the index build are untouched. Stemming, stop
  words and boosts are #5's (30-question recall@5 set). This issue pins five questions only.
- **No REST form for resources or the prompt.** Prompts are MCP-only (AGENTS.md). The REST
  equivalent of `bioc://docs/{+path}` is `GET /api/v1/docs/read?id_or_url=bioc://docs/<path>`,
  which paginates. There is no `/api/v1/docs/pages` route.
- **No runtime fetch of any kind** in the docs module: it has `upstreams: []`.
- **No `ops_*` cross-reference by name.** `ops_activity` (#9) does not exist yet. The descriptions
  say what the docs do not cover (live repo activity, failing workflows) without naming a tool that
  does not exist. #9 adds the name, as #6 did for `pkg_*`. `pkg_status` exists and is named.
- **No change to the envelope, `invokeCapability`, the REST transport, upstream adapters or
  `scripts/`.** The only change to `src/docs-index/` is an optional `filter` parameter on
  `search`.
- **#22's other items** (store/index id agreement, the non-https record test, the fixture path guard)
  stay in #22. The query-length part of #22 security-r0-2 is covered at the capability boundary
  (`query` ≤ 256 characters). The seam itself still accepts any length.
- **No MCP `cacheHints` for `resources/list`, `resources/templates/list` or `prompts/list`**; they
  keep the SDK default. #12 checks cache hints.
- **No README rewrite** (#20 ux tracks the stale tools list; #12 writes "Connect").

## Design

### Files

```
src/core/capability.ts          ResourceListing, ResourceTemplateDef, PromptDef, definePrompt(),
                                BundledDataset; Module gains resources?, prompts?, datasets?
src/core/registry.ts            modules = [metaModule, pkgModule, docsModule];
                                validateRegistry checks resource templates and prompts
src/core/about.ts               AboutSchema.datasets; buildAbout fills it from Module.datasets
src/transports/mcp.ts           registers the selected modules' resource templates and prompts
src/docs-index/load.ts          search(query, limit?, filter?)
src/core/docs/pages.ts          NEW  DocsPage, DocsPages, docsPages(), sectionLabel(),
                                     renderSection(), renderPage(), docsSource()
src/core/docs/chunk.ts          NEW  DOCS_READ_TEXT_BUDGET, chunkText()
src/core/docs/search.ts         NEW  docsSearchCapability(), DocsSearchDataSchema, snippet()
src/core/docs/read.ts           NEW  docsReadCapability(), DocsReadDataSchema, resolveDocsTarget(),
                                     docsNotFound()
src/core/docs/resources.ts      NEW  docsPageResource()
src/core/docs/prompts.ts        NEW  explainDecisionPrompt
src/core/docs/index.ts          NEW  createDocsModule(), docsModule
AGENTS.md                       one paragraph: resources and prompts (below)
test/support/docs.ts            NEW  fixtureDocsIndex(), syntheticDocsIndex(), docsTestModule()
test/core/docs/pages.test.ts    NEW
test/core/docs/chunk.test.ts    NEW
test/core/docs/search.test.ts   NEW
test/core/docs/read.test.ts     NEW
test/core/docs/resources.test.ts NEW
test/core/docs/prompts.test.ts  NEW
test/transports/docs.test.ts    NEW  MCP + REST over the docs module
test/core/registry.test.ts      new validateRegistry cases
test/core/about.test.ts         datasets cases
test/docs-index/load.test.ts    filter cases
```

Imports as everywhere: `import * as z from 'zod'`; from the SDK,
`import { McpServer, ResourceNotFoundError, ResourceTemplate, createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server'`.

### `src/core/capability.ts` (additions)

```ts
import type { Source } from '../envelope';

/** One entry of a resource template's `resources/list`; mimeType comes from the template. */
export interface ResourceListing {
  uri: string; // matches the template, e.g. 'bioc://docs/adr/0009-client-addresses-are-hashed-at-the-edge.html'
  name: string; // the template variable's value, e.g. 'adr/0009-client-addresses-are-hashed-at-the-edge.html'
  title: string;
  description: string;
}

/** An MCP resource template. MCP only: REST reaches the same data through a capability. */
export interface ResourceTemplateDef {
  name: string; // /^[a-z]+(-[a-z]+)*$/, unique across modules; MCP template name
  uriTemplate: string; // RFC 6570, starts with `bioc://<module>/`; use {+var} for values containing '/'
  title: string;
  description: string;
  mimeType: string;
  list(): ResourceListing[];
  /** Full text at `uri`. Throws CapabilityError('not_found', message) when nothing is there. */
  read(uri: string): string;
}

/** An MCP prompt. MCP only: prompts have no REST form. */
export interface PromptDef<A extends z.ZodObject = z.ZodObject> {
  name: string; // /^[a-z]+(-[a-z]+)*$/, unique across modules
  title: string;
  description: string;
  args: A; // flat object of string fields: MCP prompt arguments are strings
  tools: readonly string[]; // every capability the prompt text tells the model to call
  // Method syntax on purpose: bivariant parameters let PromptDef<Specific> sit in PromptDef[].
  render(args: z.output<A>): string; // text of the single user message
}

export function definePrompt<A extends z.ZodObject>(def: PromptDef<A>): PromptDef<A> {
  return def;
}

/** Data built ahead of time and bundled with the Worker; listed by bioc://about. */
export interface BundledDataset {
  id: string; // kebab-case, e.g. 'docs-index'
  description: string;
  built_at: string; // ISO 8601
  build_commit: string | null;
  inputs: Source[]; // each input URL with its as_of
}

export interface Module {
  name: string;
  description: string;
  upstreams: Upstream[];
  capabilities: Capability[];
  resources?: readonly ResourceTemplateDef[]; // registered when the module is in the toolset
  prompts?: readonly PromptDef[]; // registered when the toolset has every tool in prompt.tools
  datasets?: () => BundledDataset[]; // called by buildAbout; may load bundled data on first call
}
```

`meta`, `pkg` and the test modules do not change: all three new fields are optional.

### `src/core/registry.ts`

`export const modules: readonly Module[] = [metaModule, pkgModule, docsModule];`

`validateRegistry` adds these checks, in module order, after the existing per-module checks. The
first violation throws `Error`:

| Check | Message |
|---|---|
| resource template `name` matches `/^[a-z]+(-[a-z]+)*$/` | `` Resource template "${name}" must match ${RE} `` |
| resource template names unique across modules | `` Duplicate resource template name "${name}" `` |
| `uriTemplate` starts with `` `bioc://${module.name}/` `` | `` Resource template "${name}" uriTemplate must start with "bioc://${module.name}/" `` |
| prompt `name` matches `/^[a-z]+(-[a-z]+)*$/` | `` Prompt "${name}" must match ${RE} `` |
| prompt names unique across modules | `` Duplicate prompt name "${name}" `` |
| `prompt.description.trim() !== ''` | `` Prompt "${name}" has an empty description `` |
| every `z.toJSONSchema(prompt.args, { io: 'input' }).properties` entry has `type: 'string'` | `` Prompt "${name}" argument "${field}" must be a string; MCP prompt arguments are strings `` |
| every name in `prompt.tools` is a capability in **any** registered module (checked after all modules are read) | `` Prompt "${name}" names unknown tool "${tool}" `` |

### `src/core/about.ts`

```ts
export const AboutSchema = z.object({
  // … unchanged fields …
  datasets: z.array(
    z.object({
      id: z.string(),
      module: z.string(), // the module that declared it
      description: z.string(),
      built_at: z.string(),
      build_commit: z.string().nullable(),
      inputs: z.array(SourceSchema), // from '../envelope'
    }),
  ),
});
```

`buildAbout(modules)` adds
`datasets: modules.flatMap((m) => (m.datasets?.() ?? []).map((d) => ({ id: d.id, module: m.name, description: d.description, built_at: d.built_at, build_commit: d.build_commit, inputs: d.inputs })))`,
in module order. Field order follows the schema. `datasets` comes last in the about object.

### `src/transports/mcp.ts`

In `buildMcpServer(all, selected, deps)`, after the tools and before `bioc://about`:

```ts
const toolNames = new Set(selected.flatMap((module) => module.capabilities.map((c) => c.name)));
for (const module of selected) {
  for (const def of module.resources ?? []) {
    server.registerResource(
      def.name,
      new ResourceTemplate(def.uriTemplate, {
        list: () => ({ resources: def.list().map((r) => ({ ...r, mimeType: def.mimeType })) }),
      }),
      { title: def.title, description: def.description, mimeType: def.mimeType },
      (uri) => {
        let text: string;
        try {
          text = def.read(uri.href);
        } catch (error) {
          if (error instanceof CapabilityError && error.code === 'not_found') {
            throw new ResourceNotFoundError(uri.href, error.message);
          }
          throw error;
        }
        return { contents: [{ uri: uri.href, mimeType: def.mimeType, text }] };
      },
    );
  }
  for (const prompt of module.prompts ?? []) {
    if (!prompt.tools.every((tool) => toolNames.has(tool))) continue;
    server.registerPrompt(
      prompt.name,
      { title: prompt.title, description: prompt.description, argsSchema: prompt.args },
      (args) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text: prompt.render(args) } }] }),
    );
  }
}
```

The `resources/read` cache hint (300 s, public) already configured applies to docs pages. A prompt
is skipped on a toolset missing one of its tools, so `/mcp/pkg` never offers a prompt that names
`docs_search`. That rule also covers #10's cross-module prompt.

### `src/docs-index/load.ts`

```ts
/** … `filter` keeps only hits whose record it accepts; applied inside the ranked search, before `limit`. */
search(query: string, limit?: number, filter?: (record: DocsRecord) => boolean): DocsSearchHit[];
```

Implementation: when `filter` is given, call
`miniSearch.search(query, { filter: (result) => { const record = byId.get(result.id as string); return record !== undefined && filter(record); } })`,
otherwise `miniSearch.search(query)` as today. The `RangeError` for a bad `limit` is unchanged and
still comes before the search. `DocsSearchHit` is unchanged.

### `src/core/docs/pages.ts`

```ts
export interface DocsPage {
  id: string; // page-level record id: 'site:<href without #>' or 'repo:<repo>/<file>'
  path: string; // resource path: id minus 'site:' for site/adr pages; 'repo/' + id minus 'repo:' for repo docs
  uri: string; // `bioc://docs/${path}`
  url: string; // new URL(record.url) with hash '' → .href, e.g. 'https://seandavi.github.io/bioc-infrastructure/propagation-gate.html'
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

/** Pages of `index`, built once per index (WeakMap cache). Throws Error on a duplicate page path. */
export function docsPages(index: DocsIndex): DocsPages;

/** Section label: record.section; else the URL fragment as words ('why-at-the-edge' → 'Why at the edge'); '' for a page-level record. */
export function sectionLabel(record: DocsRecord): string;

/** '## <label>\n\n<url>\n\n<body>' (see Rendering). */
export function renderSection(record: DocsRecord): string;

/** '# <title>\n\n<page url>\n\n<page-level body>' + '\n\n' + renderSection(r) for every other record; an ADR's page-level body stops where its first section starts. */
export function renderPage(page: DocsPage): string;

/** Provenance for an index input: { url: input.url, as_of: input.last_modified ?? input.fetched_at }. */
export function docsSource(input: DocsInput): Source;
```

A record's page key is `new URL(record.url)` with `hash = ''`, `.href`. Its page id is
`record.id.split('#')[0]`. The record whose `id` equals the page id is the page-level record.
`section(page, fragment)` compares `new URL('#' + fragment, page.url).hash` with each record's
`new URL(record.url).hash`. This normalises percent-encoding of non-ASCII anchors.

**`sectionLabel`.** `record.section` when non-empty. For a page-level record, `''`. Otherwise the
fragment, `decodeURIComponent`d, with `-` replaced by a space, runs of spaces collapsed, trimmed,
and the first character upper-cased. Example: `#why-at-the-edge-rather-than-at-ingest` becomes
`Why at the edge rather than at ingest`, and `#context` becomes `Context`.

**Rendering.** The body of a record is its `text` with two changes:

1. When `source !== 'repo'` and `section !== ''` and `text.startsWith(section + '\n')`, drop that
   first line. Site sections repeat their heading (Verified).
2. Replace `/\n{3,}/g` with `'\n\n'`, then trim.

`renderSection(r)` = `` `## ${sectionLabel(r) || r.title}\n\n${r.url}\n\n${body(r)}` `` (an empty
body leaves the URL line last). `renderPage(page)` = `` `# ${page.title}\n\n${page.url}\n\n` `` + the
page-level body, then `'\n\n' + renderSection(r)` for every other record in `page.records`
order. An ADR's page-level record holds the whole ADR and its section records repeat that text
(**Verified**, `search.json`), so the page-level body is cut where the first section's non-empty
`body()` starts (`pageBody.indexOf(body)`, trimmed). That keeps the `Status:` and `Date:` lines and
shows each section once. If that body is not found in the page-level body (site pages, whose
page-level text is only the intro), the page-level body is kept whole. With no page-level record, the header is followed directly by the sections. The output is a
pure function of the records, and the same text serves `docs_read` and the resource.

### `src/core/docs/chunk.ts`

```ts
/** UTF-8 bytes of JSON.stringify(chunk) minus the quotes: the docs_read text budget per call. */
export const DOCS_READ_TEXT_BUDGET = 5500;

/**
 * The part of `text` from `start` whose JSON-escaped UTF-8 size is at most `budget`, ending after
 * the last '\n' (else ' ') in the part's second half when the part is not the end of the text.
 * Never splits a surrogate pair. `end` is the offset of the next part (=== text.length at the end).
 * Throws RangeError unless 0 <= start <= text.length (start === text.length gives { text: '', end: start })
 * and unless budget >= 6 (the largest cost of one code point), so every call advances.
 */
export function chunkText(text: string, start: number, budget = DOCS_READ_TEXT_BUDGET): { text: string; end: number };
```

Algorithm:

1. Walk code points from `start` (`codePointAt`, step 2 for astral code points). Cost per code
   point is the byte length `JSON.stringify` gives it:
   - 2 for `"`, `\`, `\b`, `\f`, `\n`, `\r`, `\t`;
   - 6 for any other code point below `0x20` and for a lone surrogate;
   - 1 below `0x80`, 2 below `0x800`, 3 below `0x10000`, 4 above.

   Stop before the code point that would exceed `budget`. That position is `hard`.
2. If `hard === text.length`, then `end = hard`.
3. Otherwise let `half = start + Math.floor((hard - start) / 2)`. Set `end` to one past the last
   `\n` in `[half, hard)`. If there is none, use one past the last space in that range. If there is
   none either, `end = hard`.
4. Return `{ text: text.slice(start, end), end }`.

Because `budget` ≥ 6, every call that is not at the end advances by at least one code point.

### `src/core/docs/search.ts`: `docs_search`

```ts
const SourceFilterSchema = z
  .string()
  .regex(/^(site|adr|repo:[A-Za-z0-9._-]+)$/, "source must be 'site', 'adr' or 'repo:<name>'")
  .describe("Narrow to 'site' (the infrastructure site's pages), 'adr' (architecture decision records) or 'repo:<name>' (one bioc-* repo's docs, e.g. 'repo:bioc-registry')");

export const DocsSearchInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(256)
    .regex(/\S/, 'query must contain a non-space character')
    .describe('Words to search for, e.g. "why does the registry poll"'),
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
});

export const DocsSearchDataSchema = z.object({
  query: z.string(),
  source: z.string().nullable(),
  hits: z.array(DocsSearchHitSchema).describe('Best first'),
  omitted_for_size: z.number().int().nonnegative().describe('Hits dropped from the end to stay under 8 KB'),
});

export function docsSearchCapability(getIndex: () => DocsIndex): Capability<typeof DocsSearchInputSchema, typeof DocsSearchDataSchema>;

/** About 200 characters of `text` around the first query word (see below). Exported for tests. */
export function snippet(text: string, query: string): string;
```

Capability: `module: 'docs'`, `name: 'docs_search'`, `title: 'Search the infrastructure docs'`,
`description`:

> Search the Bioconductor infrastructure docs for why or how something works: architecture
> decision records (ADRs), runbooks, design notes and API docs from the bioc-infrastructure site
> and the READMEs and docs of the seandavi/bioc-* repos. Returns ranked sections with title, url,
> breadcrumb, snippet and score. Pass a hit's url to docs_read for the full text. source narrows to
> 'site', 'adr' or 'repo:<name>' (e.g. 'repo:bioc-registry'). The docs describe design and
> procedure, not live state: for a package's current build, check or propagation state use
> pkg_status. Open issues, failing workflows and other live repo activity are not in the docs.

MCP tool `docs_search`; REST
`GET /api/v1/docs/search?query=why+does+the+registry+poll&limit=5&source=site`.

Handler (`{ query, limit, source }`, `deps` unused):

1. `index = getIndex()`, `q = query.trim()`.
2. Filter. With `source` undefined, there is no filter. `'site'` and `'adr'` keep records with that
   `source`. `'repo:<name>'` keeps records with `source === 'repo' && repo === name`. If no record
   has that repo, throw `CapabilityError('invalid_input', `Unknown docs source "${source}". Valid: site, adr, ${repos.map((r) => 'repo:' + r).join(', ')}.`)`,
   where `repos` are the distinct `repo` values in store order.
3. `found = index.search(q, limit, filter)`.
4. Each hit is `{ url: record.url, title, section: sectionLabel(record), crumbs, source, repo: record.repo ?? null, snippet: snippet(record.text, q), score: Math.round(score * 100) / 100 }`.
5. `sources` are the distinct `docsSource(index.inputFor(record.id)!)` of the hits, in first-hit
   order, deduplicated by `url`. With no hits, `sources` is `[]`.
6. `summary`:
   - hits: `` `${n} docs section${n === 1 ? '' : 's'} for "${q}"${source ? ` in ${source}` : ''}:` ``,
     then one line per hit, `` `\n${i + 1}. ${title}${section ? ` › ${section}` : ''} ${url}` ``.
     When `omitted_for_size > 0`, append
     `` `\n${k} more hit${k === 1 ? ' was' : 's were'} dropped to stay under 8 KB; lower limit for fewer, longer results.` ``.
   - no hits: `` `No docs sections match "${q}"${source ? ` in ${source}` : ''}. Try other words${source ? ' or drop source' : ''}. For live package state use pkg_status.` ``
7. **Size guard:** while `envelopeBytes(envelope) > MAX_RESULT_BYTES` and hits remain, drop the
   last hit, increment `omitted_for_size`, and rebuild `sources` and `summary`. Then return.
   `invokeCapability`'s own size check stays as the backstop.

**`snippet(text, query)`:**

1. `plain = text.replace(/\s+/g, ' ').trim()`. If `plain.length <= 200`, return `plain`.
2. `words` = the distinct lower-cased tokens of `query`, split on `/[^\p{L}\p{N}]+/u`, keeping those
   with at least 3 characters.
3. `p` = the smallest index `i` such that `lower.startsWith(w, i)` for some word and `i` is at a
   word start (`i === 0`, or `lower[i - 1]` does not match `/[\p{L}\p{N}]/u`). Here
   `lower = plain.toLowerCase()`. With no match, `p = -1`.
4. `start = p <= 0 ? 0 : Math.max(0, p - 60)`. If `start > 0`, let `s = plain.indexOf(' ', start)`.
   If `s !== -1 && s < p`, set `start = s + 1`.
5. `end = Math.min(plain.length, start + 200)`. If `end < plain.length`, let
   `e = plain.lastIndexOf(' ', end)`. If `e > start + 100`, set `end = e`. If `end` falls between
   a high and a low surrogate, decrement it.
6. Return `(start > 0 ? '…' : '') + plain.slice(start, end) + (end < plain.length ? '…' : '')`
   (at most 202 characters).

#### Ranking questions

The five known questions. Each one asserts the top hit on the fixture index (Verified):

| # | query | source | `hits[0].url` |
|---|---|---|---|
| 1 | `why does the registry poll` | none | `https://seandavi.github.io/bioc-infrastructure/propagation-gate.html#why-the-registry-polls` |
| 2 | `why are client addresses hashed` | `adr` | `https://seandavi.github.io/bioc-infrastructure/adr/0009-client-addresses-are-hashed-at-the-edge.html` |
| 3 | `how are download stats counted` | none | `https://seandavi.github.io/bioc-infrastructure/download-stats.html#what-counts-as-a-download` |
| 4 | `purging the cache` | none | `https://seandavi.github.io/bioc-infrastructure/cache.html#purging` |
| 5 | `DuckDB sql console` | none | `https://github.com/seandavi/bioc-registry/blob/main/docs/api.md#get-sql` |

### `src/core/docs/read.ts`: `docs_read`

```ts
export const DocsReadInputSchema = z.object({
  id_or_url: z
    .string()
    .min(1)
    .max(2048)
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

/** Resolves only against the index; never fetches. */
export function resolveDocsTarget(pages: DocsPages, input: string): DocsTarget;

/** The not_found error for a missing target, with up to 5 close matches from the index. */
export function docsNotFound(index: DocsIndex, pages: DocsPages, input: string, target: Extract<DocsTarget, { kind: 'missing' }>): CapabilityError;

export function docsReadCapability(getIndex: () => DocsIndex): Capability<typeof DocsReadInputSchema, typeof DocsReadDataSchema>;
```

Capability: `module: 'docs'`, `name: 'docs_read'`, `title: 'Read a docs page or section'`,
`description`:

> Read the full text of one Bioconductor infrastructure docs page or section, as Markdown with
> links. Pass a url from docs_search: a url with #anchor reads that section, a url without one reads
> the whole page. A record id or a bioc://docs/ URI also works. Long text comes in parts: call again
> with cursor set to next_cursor. Reads only the docs index bundled with this server and never
> fetches a URL, so a URL that is not in the index returns not_found with close matches. To find a
> page, use docs_search. For live package state use pkg_status.

MCP tool `docs_read`; REST
`GET /api/v1/docs/read?id_or_url=https%3A%2F%2Fseandavi.github.io%2Fbioc-infrastructure%2Fpropagation-gate.html%23why-the-registry-polls&cursor=5498`
(`#` must be sent as `%23`).

**`resolveDocsTarget(pages, input)`:**

1. `s = input.trim()`. Split at the first `#` into `base` and `fragment`. If there is no `#`, or
   nothing follows it, `fragment` is `null`.
2. Find the page:
   - `base` starts with `bioc://docs/`: `pages.byPath.get(base.slice('bioc://docs/'.length))`.
   - `base` starts with `site:` or `repo:`: `pages.byId.get(base)`.
   - `base` starts with `https://`: `pages.byUrl.get(new URL(base).href)`. If `new URL` throws,
     there is no page.
   - Otherwise there is no page. This covers `http:` URLs, bare hrefs and free text.
3. No page gives `{ kind: 'missing', page: null, fragment }`. A page with `fragment === null` gives
   `{ kind: 'page', page }`.
4. Otherwise `record = pages.section(page, fragment)`. A record gives
   `{ kind: 'section', page, record }`; no record gives `{ kind: 'missing', page, fragment }`.

The input is never fetched, whatever its host.

**`docsNotFound`.** `shown` is the input truncated to 200 characters, with `…` appended when
truncated.

- **Bounded search terms.** Caller text reaches MiniSearch, which runs one prefix + fuzzy sub-query
  per token with no dedupe, so both branches take their words from `closeMatchTerms(text, ignore)`:
  lower-case, split on `/[^a-z0-9]+/`, keep words of at least 3 characters that are not in
  `ignore`, drop duplicates, keep at most 8 words, each cut to 32 characters. One call is at most
  8 sub-queries whatever the input length.
- **Known page, unknown section.** `matches` are the `url`s of
  `index.search(fragmentWords, 5, (r) => r.id !== page.id && page.records.includes(r))`, where
  `fragmentWords = closeMatchTerms(fragment).join(' ')`. If that is empty
  or gives no hits, use the first 5 non-page-level records of the page, in order. The message is
  `` `No section "#${fragment}" on ${page.url}. Sections on that page include: ${matches.join(', ')}. docs_read reads only the docs index and never fetches URLs.` ``
- **Otherwise.** `words` = `closeMatchTerms(input, URL_NOISE)`, where `URL_NOISE` is:

  ```ts
  const URL_NOISE = new Set(['https', 'http', 'www', 'com', 'org', 'github', 'githubusercontent', 'raw', 'blob', 'tree', 'main', 'seandavi', 'html', 'htm', 'bioc', 'infrastructure', 'docs', 'site', 'repo']);
  ```

  `matches` are the distinct `url`s of `index.search(words.join(' '), 5)`, or `[]` when there are no
  words. The message is
  `` `No docs page or section matches "${shown}". docs_read reads only the docs index and never fetches URLs; pass a url from docs_search, a record id or a bioc://docs/ URI.` ``,
  followed by `` ` Close matches: ${matches.join(', ')}.` `` when there are matches, else
  `' Use docs_search to find one.'`

The result is `new CapabilityError('not_found', message)`: REST 404, MCP `isError` text
`not_found: …`.

**Handler** (`{ id_or_url, cursor }`, `deps` unused):

1. `index = getIndex()`, `pages = docsPages(index)`, `target = resolveDocsTarget(pages, id_or_url)`.
   For `missing`, throw `docsNotFound(…)`.
2. `full` is `renderPage(target.page)` for a page and `renderSection(target.record)` for a section.
3. `offset = cursor === undefined ? 0 : Number(cursor)`. If `offset > full.length`, or
   `offset === full.length && offset > 0`, throw
   `CapabilityError('invalid_input', `cursor ${cursor} is past the end of the text (${full.length} characters); start again without cursor`)`.
4. `{ text, end } = chunkText(full, offset)`. `next_cursor = end < full.length ? String(end) : null`.
5. Data: `kind`; `url` (the page url, or `record.url`); `resource_uri: page.uri`; `title: page.title`;
   `section` (`''`, or `sectionLabel(record)`); `crumbs`, `source` and `repo` from the page or the
   record; `text`; `offset`; `total_chars: full.length`; `next_cursor`.
6. `sources: [docsSource(target.page.input)]`.
7. `summary`. `label` is `` `"${title}"` `` for a page and `` `"${title}" › ${section}` `` for a
   section.
   - one part (`offset === 0 && next_cursor === null`):
     `` `${label} (${url}), full text, ${full.length} characters.` ``
   - otherwise: `` `${label} (${url}), characters ${offset + 1}–${end} of ${full.length}.` ``, plus
     `` ` Call docs_read again with cursor "${next_cursor}" for the rest.` `` when `next_cursor` is
     set.

### `src/core/docs/resources.ts`

```ts
export function docsPageResource(getIndex: () => DocsIndex): ResourceTemplateDef;
```

- `name: 'docs-page'`, `uriTemplate: 'bioc://docs/{+path}'`, `title: 'Docs page'`,
  `mimeType: 'text/markdown'`. The `description` is
  `'One page of the Bioconductor infrastructure docs (a site page, an ADR, or a bioc-* repo document) as Markdown, whole. Paths: <page>.html, adr/<adr>.html, repo/<repo>/<file>.md. For a part of a page, or over REST, use docs_read.'`
- `list()`: for each page in `docsPages(getIndex()).list`,
  `{ uri: page.uri, name: page.path, title: page.title, description: page.url }`.
- `read(uri)`: the target is `resolveDocsTarget(pages, uri)`. Only `bioc://docs/` URIs reach this
  callback, because the template matched them. A `page` target returns `renderPage(page)`. A
  `section` target returns `renderSection(record)`: **Verified**, the template matches
  `bioc://docs/x.html#frag` with `path: 'x.html#frag'`, so a URI with a fragment reads that
  section. A query string stays in `path` and does not match a page. A `missing` target throws
  `docsNotFound(…)`. A URI longer than `MAX_DOCS_REFERENCE_LENGTH` (2048, also the `id_or_url`
  maximum, exported from `read.ts`) throws `CapabilityError('not_found', …)` naming `docs_search`
  before anything is resolved, because the SDK's URI template accepts up to 1e6 characters. The resource returns the **whole** page with no 8 KB limit. AGENTS.md's limit
  is for tool results, and a resource is attached deliberately. The largest page today is 37 KB.

### `src/core/docs/prompts.ts`

```ts
export const explainDecisionPrompt = definePrompt({
  name: 'explain-decision',
  title: 'Explain an infrastructure decision',
  description:
    'Explain why Bioconductor infrastructure works the way it does on a topic, from its architecture ' +
    'decision records (ADRs): searches the ADRs, reads the relevant one, and answers quoting it with links.',
  args: z.object({
    topic: z.string().min(1).max(200).describe('The decision or design question, e.g. "why are client addresses hashed"'),
  }),
  tools: ['docs_search', 'docs_read'],
  render: ({ topic }) => [
    `Explain the Bioconductor infrastructure decision about: ${topic}`,
    '',
    `1. Call docs_search with query ${JSON.stringify(topic)} and source "adr". If no ADR is relevant, call docs_search again without source.`,
    '2. Call docs_read with the url of the most relevant hit. An ADR\'s status, context, decision and consequences matter most; read further hits only if the first does not settle the question.',
    '3. Answer: state the decision, then why it was made and what it trades away. Quote the ADR\'s own words in short block quotes and link each quote to the url docs_read returned. Name the ADR by number and title, and give its status (for example "Superseded by 0012") when the page states one.',
    '4. If the docs record no decision on this topic, say so plainly and list the closest pages you found. Do not guess.',
  ].join('\n'),
});
```

### `src/core/docs/index.ts`

```ts
/** The docs module over `getIndex` (called on first use, never at import). */
export function createDocsModule(getIndex: () => DocsIndex): Module {
  return {
    name: 'docs',
    description: 'Search and read the Bioconductor infrastructure docs: the bioc-infrastructure site, its ADRs, and the bioc-* repos\' docs.',
    upstreams: [],
    capabilities: [docsSearchCapability(getIndex), docsReadCapability(getIndex)],
    resources: [docsPageResource(getIndex)],
    prompts: [explainDecisionPrompt],
    datasets: () => {
      const { meta } = getIndex();
      return [{
        id: 'docs-index',
        description: 'Docs index (MiniSearch BM25) built in CI from docs-sources.yaml and bundled with this Worker; docs_search, docs_read and bioc://docs/ read only this.',
        built_at: meta.built_at,
        build_commit: meta.build_commit,
        inputs: meta.inputs.map(docsSource),
      }];
    },
  };
}

export const docsModule = createDocsModule(bundledDocsIndex);
```

The capabilities, resources and about all read the index through `getIndex`. In production this
is `bundledDocsIndex`, loaded once per isolate on first use. Tests pass a fixture or synthetic
index. `defineCapability` runs inside the factory, so each call returns new capability objects;
`validateRegistry`'s name uniqueness applies as before.

### AGENTS.md

Append to the "Adding a capability" paragraph under Commands:

```markdown
MCP resources and prompts belong to a module too: `resources` (a `ResourceTemplateDef` under
`bioc://<module>/`) and `prompts` (`definePrompt`, listing every tool its text names in `tools`).
Both are MCP only; a prompt is offered only on toolsets that include all of its tools. Bundled,
build-time data (like the docs index) is reported to `bioc://about` through `datasets`.
```

### Upstream calls and fixtures

None at runtime. The docs module has `upstreams: []`, never calls `deps.fetch`, and adds no fixture
files. Tests use the #3 fixtures through `test/docs-index/support.ts`'s `fixtureArtifact()`
(`test/fixtures/docs/…`, 16 recorded inputs), plus synthetic indexes built in memory.

### `test/support/docs.ts`

```ts
/** loadDocsIndex over the shared fixture build (test/docs-index/support.ts fixtureArtifact). */
export function fixtureDocsIndex(): Promise<DocsIndex>;
/** A DocsIndex over `records` (one input, https://docs.test/search.json, fetched_at 2026-10-22T00:00:00.000Z): builds the store and a MiniSearch with DOCS_INDEX_OPTIONS in memory. */
export function syntheticDocsIndex(records: DocsRecord[]): DocsIndex;
/** createDocsModule over the fixture index. */
export function docsTestModule(): Promise<Module>;
```

## Acceptance criteria

- [ ] `npm ci && npm run typecheck && npm test && npm run build` pass on a clean checkout with the
      network disabled. The PR reports the gzip bundle size from `npm run build` (expected about
      650 KiB, under the 3 MB limit; #3 measured 647 KiB with the index referenced).
- [ ] `modules` is `[metaModule, pkgModule, docsModule]`, and `validateRegistry(modules)` passes.
- [ ] `tools/list` on `/mcp/docs` is exactly `docs_read, docs_search` (sorted). `/mcp` includes
      them alongside `meta_ping` and `pkg_status`. Each has `outputSchema` with `data`, `summary`
      and `sources`, and `readOnlyHint: true`.
- [ ] **Descriptions:** `docs_search` and `docs_read` descriptions name `docs_read`/`docs_search`
      and `pkg_status`, say the docs hold no live state, and name no tool absent from `modules`.
      A test checks every `/\b[a-z]+_[a-z_]+\b/` tool-like token in both descriptions that starts
      with a registered module prefix against the registered capability names.
- [ ] **Ranking:** the five [ranking questions](#ranking-questions) return the listed `hits[0].url`
      on the fixture index, through the capability (`invokeCapability`). With `source: 'adr'`,
      `redirects` returns `adr/0013-…` first and every hit has `source: 'adr'`. With
      `source: 'repo:bioc-edge'`, `data plane` returns only hits with `repo: 'bioc-edge'`.
- [ ] `docs_search` defaults to 8 hits for `registry`, returns ≤ 3 with `limit: 3`, and rejects
      `limit: 11`, `limit: 0`, `query: '   '`, a 257-character query and `source: 'repo:'` with
      `invalid_input`. `source: 'repo:nope'` gives `invalid_input` listing `repo:bioc-registry`.
- [ ] Every hit parses with `DocsSearchHitSchema`. Snippets are ≤ 202 characters. ADR sections have
      a non-empty `section` derived from their anchor (e.g. `Decision`). `sources` are the distinct
      inputs of the hits, with `as_of` equal to the input's `fetched_at` in the fixture build.
- [ ] **Size guard:** on a synthetic index whose 10 matching records have 190-character titles,
      sections and URLs, `limit: 10` returns an envelope ≤ 8,192 bytes with `omitted_for_size > 0`.
      The summary says how many were dropped.
- [ ] **docs_read resolution:** the page URL, the page-level id and `bioc://docs/propagation-gate.html`
      each read the whole page (`kind: 'page'`). `…/propagation-gate.html#why-the-registry-polls`
      and `site:propagation-gate.html#why-the-registry-polls` read that section (`kind: 'section'`,
      `section: 'Why the registry polls'`). `bioc://docs/repo/bioc-edge/DATAPLANE.md` reads the
      DATAPLANE page.
- [ ] **Pagination over the whole fixture corpus:** for every page and every non-page record,
      following `next_cursor` from no cursor until `null` gives envelopes that are all ≤ 8,192
      bytes (`invokeCapability` returns `ok`). The parts' `text` concatenates to exactly
      `renderPage`/`renderSection`. Each part's `offset` equals the previous cursor. The
      `proposal-unified-search.html` page takes more than one part.
- [ ] `cursor` past the end gives `invalid_input`. A non-digit `cursor` gives `invalid_input`.
- [ ] **Unknown URL:** `docs_read` with
      `https://seandavi.github.io/bioc-infrastructure/propagation-gates.html` returns `not_found`.
      The message lists `https://seandavi.github.io/bioc-infrastructure/propagation-gate.html…` as
      a close match and says the tool never fetches URLs. `https://evil.example/x` returns
      `not_found`. For both, the injected `fetch` (a `fixtureFetch({})` that records calls) has
      `calls` equal to `[]`, over MCP and over REST (404).
- [ ] `…/propagation-gate.html#nope` returns `not_found` naming the page and listing section URLs
      of that page only.
- [ ] **Bounded close-match search:** a spy on `index.search` shows `docs_read` with a ~2,000-character
      `#a.b.c…` fragment of distinct words, or a 2,048-character unknown URL of distinct 3-letter
      words, searches once with exactly 8 terms; repeated words give one term; words under 3
      characters give no search; a 2,000-character word is cut to 32. The resource `read()` with a
      1,900-character fragment searches with ≤ 8 terms, and with a URI over 2,048 characters throws
      `not_found` without searching.
- [ ] **ADR pages show each section once:** for all 13 ADR pages, `renderPage` contains the
      `Status:` and `Date:` lines and each section body exactly once.
- [ ] **Resources:** on `/mcp/docs`, `resources/templates/list` has `docs-page` with
      `uriTemplate: 'bioc://docs/{+path}'`. `resources/list` has `bioc://about` plus one
      `bioc://docs/…` entry per page (56 on the fixture index) with `mimeType: 'text/markdown'`.
      `resources/read` of `bioc://docs/adr/0009-client-addresses-are-hashed-at-the-edge.html`
      returns text starting `# 0009 — Client addresses are hashed at the edge` and containing
      `## Decision` and that page's `#decision` URL. `bioc://docs/nope.html` fails with code
      `-32602` and a message containing `docs_search`. On `/mcp/pkg`, `resources/list` is only
      `bioc://about`.
- [ ] **Prompt:** `prompts/list` on `/mcp/docs` and `/mcp` has `explain-decision` with one
      required `topic` argument. It is absent on `/mcp/pkg` and `/mcp/meta`. `prompts/get` with
      `topic: 'why are client addresses hashed'` returns one user message that contains the topic,
      `docs_search`, `source "adr"` and `docs_read`. Every name in `explainDecisionPrompt.tools` is
      a registered capability.
- [ ] **validateRegistry** rejects: a prompt naming an unknown tool, a prompt with a non-string
      argument, a duplicate prompt name, a resource template whose `uriTemplate` is outside
      `bioc://<module>/`, and a duplicate template name. Each gives the message in the table above.
- [ ] **About:** `bioc://about` and `GET /api/v1/about` include
      `datasets: [{ id: 'docs-index', module: 'docs', built_at, build_commit, inputs }]` with 16
      inputs, when the docs module is registered, and `datasets: []` for `[metaModule, exampleModule]`.
- [ ] `DocsIndex.search` with a `filter` returns only accepted records, still at most `limit`, and
      the unfiltered call is unchanged (existing load tests pass).
- [ ] No change under `scripts/`, `src/upstreams/`, `src/envelope.ts`, `src/core/invoke.ts` or
      `src/transports/rest.ts`.
- [ ] AGENTS.md has the resources/prompts paragraph.
- [x] ~~Manual client check for `data.text`~~: superseded by #35, which made the MCP text content
      carry the serialized data for every tool; `docs_read` needs no special case.
- [ ] Manual, pasted in the PR: `npm run dev`, then `curl` of
      `/api/v1/docs/search?query=propagation+gate&source=adr` and of `/api/v1/docs/read` for the top
      hit, and an MCP `prompts/list` on `/mcp/docs`.

## Test plan

All tests run in Node with Vitest and no network. Docs tests use `fixtureDocsIndex()` (the #3
fixture build) or `syntheticDocsIndex()`. Capability tests call `invokeCapability(capability, input, deps)`
with `deps = { fetch: fixtureFetch({}), cache: createMemoryCache(now), now, env: {} }` and assert
`fetch.calls` is empty.

| File | Covers |
|---|---|
| `test/core/docs/pages.test.ts` | 56 pages on the fixture index; `path`/`uri` for a site page, an ADR and `repo/bioc-edge/DATAPLANE.md`; `byUrl`/`byId`/`byPath`; `section()` with a percent-encoded fragment; `sectionLabel` for a site section, an ADR `#context` (→ `Context`) and a page-level record (`''`); `renderSection` drops the repeated heading line and collapses blank-line runs; `renderPage` header, page-level body first, one `## ` per other record; every ADR section appears once with its `Status:`/`Date:` lines; synthetic page-level body without the first section stays whole; synthetic duplicate page path throws |
| `test/core/docs/chunk.test.ts` | text under budget → one part; cut after the last `\n` in the second half, else a space, else hard; escapes counted (`"`, `\n`, `\u0001` = 6); 3- and 4-byte characters counted and an emoji never split; `start === length` → empty; `start` out of range or `budget` 5 → RangeError; repeated calls cover the text exactly |
| `test/core/docs/search.test.ts` | the five ranking questions; `adr` and `repo:bioc-edge` filters; unknown repo; input rejections; default/explicit limit; hit shape and snippet length; ADR `section` label; `sources` distinct with `as_of`; zero-hit summary mentions `pkg_status`; size guard on a synthetic index; `snippet()` unit cases (no match → leading 200 chars + `…`, match mid-text → leading `…`, word-start only, short text unchanged) |
| `test/core/docs/read.test.ts` | every resolution form in Acceptance; whole-corpus pagination loop; summary wording for one part and for several; cursor errors; not_found close matches (unknown page, unknown section, free text with no usable words, `http:` URL, foreign host) with `fetch.calls` `[]`; long input truncated to 200 characters in the message; spy on `index.search`: ≤ 8 distinct terms of ≤ 32 characters for long fragments and URLs |
| `test/core/docs/resources.test.ts` | `list()` count, uri/name/title/description; `read()` of a page, of a repo doc, and of an unknown URI (throws `not_found`); a long fragment searches with ≤ 8 terms; a URI over 2,048 characters throws `not_found` without searching |
| `test/core/docs/prompts.test.ts` | `render` contains the topic, `docs_search`, `source "adr"`, `docs_read`; `tools` all registered in `modules`; `args` rejects `''` |
| `test/transports/docs.test.ts` | `makeTestApp({ extraModules: [await docsTestModule()] })`: `tools/list` on `/mcp/docs`; MCP `docs_search` structuredContent deep-equals REST `GET /api/v1/docs/search` body; same for `docs_read`; REST 404 JSON for an unknown URL with `fetch.calls` `[]`; REST 400 for `limit=11`; `resources/templates/list`, `resources/list`, `resources/read`, the -32602 not-found; prompts present/absent per toolset (`/mcp/docs`, `/mcp/example`); `prompts/get`; about `datasets`; production `modules` contains `docs`; descriptions name only registered tools |
| `test/core/registry.test.ts` | the five new rejection cases, and a module with a valid template and prompt passes |
| `test/core/about.test.ts` | `datasets: []` without docs; with a module declaring one dataset → `{ …, module }` in order |
| `test/docs-index/load.test.ts` | `search('gate', 8, (r) => r.source === 'adr')` all `adr` and ≤ 8; filter rejecting everything → `[]`; RangeError still thrown with a filter |

Manual (in the PR): the `npm run dev` checks in Acceptance, and `npm run build`'s bundle size.

## Risks

- **Clients that show only text content.** The MCP text content is the envelope's `summary` (#2's
  rule; #12 checks clients). `docs_search`'s summary lists every hit with its URL, so it works
  text-only. `docs_read`'s summary does not carry the page text, so a client that ignores
  `structuredContent` sees a summary and no content. Repeating the text in the summary would halve
  the per-call budget. Not verified against real clients here; the PR's manual steps check
  Claude Code (or Claude Desktop), and if the model does not see `data.text` the text moves into the
  summary. Otherwise #12 decides whether `docs_read` needs a different text content.
- **Bundle size and isolate memory.** Registering `docsModule` puts the 1.7 MB index module in the
  Worker (about 650 KiB gzip total; #3 Verified). The first docs call or `bioc://about` read costs
  the ~16 ms load. `bioc://about` now loads the index, because `datasets` reads `meta`.
- **Pagination by character offset.** The cursor is a UTF-16 offset into the rendered text. If a
  deploy rebuilds the index between two calls, a cursor can land mid-word in the new text. Each part
  is still valid Markdown text, and the summary always gives `total_chars`. Opaque or versioned
  cursors are not worth it for docs that change daily at most.
- **Resources are not size-limited.** A 37 KB page is returned whole. That is acceptable for a
  resource the user attaches deliberately, but a client that auto-attaches every listed resource would
  pull about 750 KB. The MCP spec leaves attachment to the user, and listing does not read.
- **Snippet and close-match quality** are heuristics (query words ≥ 3 characters, URL noise words).
  They are pinned by unit tests, not measured. #5's evaluation covers ranking, not snippets.
- **Prefix + fuzzy matching of stop words** (`how`, `do`, `the`) adds noise to long natural-language
  queries. This is #5's to tune in `DOCS_INDEX_OPTIONS`. The five pinned questions pass today, and
  a ranking change that breaks one fails this issue's tests on purpose.
- **`#` in REST query strings** must be sent as `%23`. Otherwise the browser or curl drops the
  fragment and `docs_read` returns the whole page instead of the section. The `docs_read`
  description says to pass a url, and the REST example in this spec encodes it. #12's REST
  quickstart should show the encoding too.
