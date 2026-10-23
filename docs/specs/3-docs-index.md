# Spec #3: Docs corpus and MiniSearch index build

Issue: [seandavi/bioc-mcp#3](https://github.com/seandavi/bioc-mcp/issues/3). Builds on
[Spec #2](2-scaffold.md) and [Spec #15](15-scaffold-followups.md). Project design:
[proposal-mcp.qmd](https://github.com/seandavi/bioc-infrastructure/blob/spec/mcp/proposal-mcp.qmd)
("Docs search"). Conventions: [AGENTS.md](../../AGENTS.md).

Everything marked **Verified** was checked on 2026-10-22 in a throwaway copy of this repo
(`git archive HEAD`, `npm ci`, the packages below added) against the live upstreams:

- **Verified:** `https://seandavi.github.io/bioc-infrastructure/search.json` is a JSON array of
  264 entries over 41 pages, each exactly `{ objectID, href, title, section, text, crumbs }`
  (`objectID === href`, every `href` unique, `crumbs` always a string array). 577,601 bytes,
  `content-type: application/json`, `last-modified` present. Text fields contain HTML entities
  (`&lt;` 224 times, `&gt;` 352 times). ADR entries have `href` starting `adr/`, and their
  `#context` / `#decision` sections carry `section: ""`.
- **Verified:** `raw.githubusercontent.com` serves the component docs with
  `content-type: text/plain`, an `etag` and **no** `last-modified`. Every `seandavi/bioc-*` repo
  in the config below is public and has the listed files on `main`. (`bioc-builder` has no
  `README.md` on `master` and is left out; `bioc-origin`, `bioc-cloudflare`,
  `bioc-contrib-intelligence`, `bioc-contributions-reviewer` and `bioc-ui-interviewer` are
  private.)
- **Verified:** `fetchUpstream` from `src/upstreams/http.ts`, run under `tsx` in Node with
  `deps.fetch = (r) => fetch(r)` and `createMemoryCache`, fetches both upstreams; `lastModified`
  is the site's header, and `null` for raw files.
- **Verified:** the record and splitting rules below give 418 records (264 site + 154 repo
  sections). Two builds are byte-identical. `JSON.stringify(miniSearch)` is 691,689 bytes and the
  records store 785,879 bytes; the generated module is 1,674,649 bytes.
  `MiniSearch.loadJSON` of the index takes 16 ms in Node.
- **Verified:** `github-slugger` anchors (after the inline-markdown stripping below) equal the
  `id="user-content-…"` anchors GitHub renders for `bioc-intelligence/README.md` (including
  `-live-dashboard--impactbioconductororg`) and `bioc-edge/DATAPLANE.md` (`cloudflare-workflows-v`).
- **Verified:** with the search options below, `propagation gate` ranks
  `site:propagation-gate.html#the-gate-check-by-check` first, `why does the registry poll` ranks
  `site:propagation-gate.html#why-the-registry-polls` first, and `client addresses hashed` ranks an
  ADR 0009 record first.
- **Verified:** a generated `generated/docs-index.js` beside a hand-shaped
  `generated/docs-index.d.ts`, imported extensionless from `src/`, passes `tsc` (TypeScript 7
  resolves the `.d.ts` and never reads the 1.6 MB `.js`), loads in Vitest 5, and bundles with
  `wrangler deploy --dry-run` (esbuild resolves the `.js`). With the index referenced from the
  entry, the bundle is 2,910 KiB / 647 KiB gzip (246 KiB gzip without it); the Workers limit is
  3 MB gzip on the free plan.
- **Verified:** `tsc` passes with `scripts` added to `tsconfig.json` `include`, default imports of
  `minisearch` and `github-slugger`, `import { parse } from 'yaml'`, `node:util` `parseArgs`, and
  top-level `await` in a script.

## Goal

A build step, run in CI, that turns the public docs corpus into one artifact the Worker imports:

- `scripts/build-docs-index.ts` fetches the docs site's Quarto `search.json` and the component
  docs listed in `docs-sources.yaml`, splits Markdown by heading, and produces records of one
  shape: `{ id, url, title, section, crumbs, text, source, repo? }`, all URLs absolute.
- It serializes a MiniSearch (BM25) index over the records plus a records store (for `docs_read`
  in #4) with build metadata (build time, this repo's commit, and per-input `last_modified`,
  `fetched_at` and content `sha256`), and writes them as a generated module,
  `generated/docs-index.js`, that the Worker bundles.
- It fails if that module exceeds `max_artifact_bytes` from the config.
- `src/docs-index/` loads the artifact (`loadDocsIndex`, `bundledDocsIndex`) and answers
  `search`, `get` and `inputFor`, the seam #4's `docs_search` and `docs_read` use.
- CI: PR CI builds the index from committed fixtures (never the network); a `Docs index` workflow
  builds it from the network daily, on `repository_dispatch` `docs-updated`, and by hand.

## Non-goals

- **No capability, MCP tool, REST route, resource or prompt.** `docs_search`, `docs_read`,
  `bioc://docs/{path}` and `explain-decision` are #4. Nothing in `src/core/registry.ts`,
  `src/transports/` or `src/index.ts` changes, so the deployed Worker does not bundle the index
  yet (esbuild drops the unreferenced `src/docs-index/bundled.ts`).
- **No change to `bioc://about`.** The build records what about needs (`meta.built_at`,
  `meta.build_commit`, `meta.inputs[]`), and `bundledDocsIndex().meta` exposes it. Wiring it into
  `AboutSchema` / `buildAbout` belongs with the module that bundles the index (#4), so the
  about document never describes an index the Worker does not serve.
- **No deploy.** The `Docs index` workflow builds, tests and uploads the artifact; #11 adds the
  `wrangler deploy` step to it.
- **No change in bioc-infrastructure.** Sending `repository_dispatch` `docs-updated` from the
  docs site's deploy needs a token there with access to this repo. That is a follow-up issue on
  bioc-infrastructure; this repo only listens. Until then the daily schedule keeps the index at
  most a day behind.
- **No ranking tuning.** Stemming, stop words and boost values are measured against the 30-question
  set in #5. This issue fixes defaults and pins one ranking.
- **No GitHub API calls.** Files come from `raw.githubusercontent.com` URLs listed in the config;
  globs such as `bioc-traffic/docs/*.md` are expanded by hand in the config
  (`bioc-traffic/docs/` holds one file today, `published-comparison.md`). Per-input freshness is
  the content `sha256` plus `last_modified` (see Risks for why not ETag or commit).
- **Corpus scope stays as the issue lists it.** `bioconductor.org` and BiocContributions docs are
  an open question in the proposal and are not added here.

## Design

### Packages (exact; `npm install`, commit `package-lock.json`)

| Package | Version | Kind | Used by |
|---|---|---|---|
| `minisearch` | `^7.2.0` | dependency | index build and the Worker loader |
| `github-slugger` | `^2.0.0` | devDependency | heading anchors (build only) |
| `yaml` | `^2.9.1` | devDependency | `docs-sources.yaml` (build only) |
| `tsx` | `^4.23.15` | devDependency | runs `scripts/build-docs-index.ts` (Node's type stripping cannot resolve the repo's extensionless imports) |

Imports: `import MiniSearch, { type Options, type SearchResult } from 'minisearch'`,
`import GithubSlugger from 'github-slugger'`, `import { parse as parseYaml } from 'yaml'`.
Zod as everywhere: `import * as z from 'zod'`.

### Files

```
docs-sources.yaml                   NEW: the corpus config (below)
.gitignore                          add `generated/`
package.json                        dependencies and scripts (below)
tsconfig.json                       "include": ["src", "test", "scripts", "vitest.config.ts"]
.github/workflows/ci.yml            add `npm run docs:fixtures` after `npm ci`
.github/workflows/docs-index.yml    NEW: daily / dispatch network build
AGENTS.md                           Layout, Rules and Commands additions (below)
src/docs-index/schema.ts            NEW: record/meta/store schemas, DOCS_INDEX_OPTIONS
src/docs-index/load.ts              NEW: loadDocsIndex(), DocsIndex
src/docs-index/bundled.ts           NEW: bundledDocsIndex(), imports generated/docs-index
scripts/build-docs-index.ts         NEW: CLI (thin)
scripts/docs-index/config.ts        NEW: DocsSourcesConfigSchema, parseDocsSourcesConfig()
scripts/docs-index/site.ts          NEW: siteRecords()
scripts/docs-index/markdown.ts      NEW: markdownRecords()
scripts/docs-index/build.ts         NEW: buildDocsIndex(), renderArtifactModule(), writeArtifactModule()
scripts/docs-index/fixtures.ts      NEW: fixtureDocsFetch(), recordingFetch()
generated/docs-index.js             GENERATED, gitignored
generated/docs-index.d.ts           GENERATED, gitignored
test/fixtures/docs/…                NEW: recorded upstream responses (below)
test/docs-index/config.test.ts      NEW
test/docs-index/site.test.ts        NEW
test/docs-index/markdown.test.ts    NEW
test/docs-index/build.test.ts       NEW
test/docs-index/load.test.ts        NEW
test/docs-index/bundled.test.ts     NEW
test/docs-index/__snapshots__/build-summary.json   NEW (written by toMatchFileSnapshot)
```

`scripts/` holds code that runs in Node at build time and is never bundled; it may import from
`src/` (schemas, `fetchUpstream`), and `src/` never imports from `scripts/`.

### `package.json` scripts (added)

```json
{
  "docs:build": "tsx scripts/build-docs-index.ts",
  "docs:fixtures": "tsx scripts/build-docs-index.ts --fixtures",
  "docs:record": "tsx scripts/build-docs-index.ts --record-fixtures",
  "predev": "tsx scripts/build-docs-index.ts --fixtures --if-missing",
  "prebuild": "tsx scripts/build-docs-index.ts --fixtures --if-missing",
  "pretest": "tsx scripts/build-docs-index.ts --fixtures --if-missing",
  "pretypecheck": "tsx scripts/build-docs-index.ts --fixtures --if-missing"
}
```

The pre-hooks exist because `src/docs-index/bundled.ts` imports `generated/docs-index`, so
`tsc`, Vitest, `wrangler dev` and the bundle all need the file. They build from fixtures only when
the file is missing, so a network build (`npm run docs:build`) is kept by every later command.
Existing scripts are unchanged.

### `docs-sources.yaml`

```yaml
# Docs corpus for the docs index, built by scripts/build-docs-index.ts.
# Every URL must be public. After editing, run `npm run docs:record` to re-record
# test/fixtures/docs, then `npx vitest run -u test/docs-index` and review the snapshot diff.

# Upper bound on generated/docs-index.js, in bytes. The Worker bundle limit is 3 MB gzip (free
# plan); the module is about 1.7 MB raw / 0.4 MB gzip on 2026-10-22.
max_artifact_bytes: 4000000

# The bioc-infrastructure docs site. Its Quarto search.json is fetched from here, and record URLs
# are resolved against it.
site_url: https://seandavi.github.io/bioc-infrastructure/

# Component docs, fetched from https://raw.githubusercontent.com/<github_owner>/<repo>/<ref>/<file>
# and linked as https://github.com/<github_owner>/<repo>/blob/<ref>/<file>#<anchor>.
github_owner: seandavi
repos:
  - repo: bioc-registry
    ref: main
    files: [README.md, docs/api.md]
  - repo: bioc-edge
    ref: main
    files: [README.md, DATAPLANE.md]
  - repo: bioc-traffic
    ref: main
    files: [README.md, docs/published-comparison.md]
  - repo: bioc-build
    ref: main
    files: [README.md]
  - repo: bioc-manifest
    ref: main
    files: [README.md]
  - repo: bioc-website
    ref: main
    files: [README.md]
  - repo: bioc-infrastructure
    ref: main
    files: [README.md]
  - repo: bioc-r-universe-build-db
    ref: main
    files: [README.md]
  - repo: bioc-intelligence
    ref: main
    files: [README.md]
  - repo: bioc-on-ice
    ref: main
    files: [README.md]
  - repo: bioc-harnesses
    ref: main
    files: [README.md]
  - repo: bioc-mcp
    ref: main
    files: [README.md]
```

That is 16 inputs: the site's `search.json`, then 15 Markdown files in the order listed.

### `scripts/docs-index/config.ts`

```ts
const segment = /^[A-Za-z0-9._-]+$/;
export const DocsSourcesConfigSchema = z.strictObject({
  max_artifact_bytes: z.number().int().positive(),
  site_url: z.url({ protocol: /^https$/ }).refine((u) => u.endsWith('/'), 'site_url must end with "/"'),
  github_owner: z.string().regex(/^[A-Za-z0-9-]+$/),
  repos: z.array(z.strictObject({
    repo: z.string().regex(segment),
    ref: z.string().regex(segment),                       // a branch or tag without "/"
    files: z.array(z.string().regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\.md$/)).min(1),
  })).min(1),
}).refine((c) => new Set(c.repos.map((r) => r.repo)).size === c.repos.length, 'each repo may appear once');
export type DocsSourcesConfig = z.infer<typeof DocsSourcesConfigSchema>;

/** YAML text → validated config. Throws Error(`docs-sources.yaml: ${z.prettifyError(…)}`). */
export function parseDocsSourcesConfig(yamlText: string): DocsSourcesConfig;
```

A path segment of `.` or `..` matches the regexes but is rejected later by `pathSegment()`.

### `src/docs-index/schema.ts`

```ts
export const DOCS_FORMAT_VERSION = 1;

export const DocsSourceKindSchema = z.enum(['site', 'adr', 'repo']);
export const DocsRecordSchema = z.object({
  id: z.string().min(1),          // 'site:<href>' or 'repo:<repo>/<file>[#<anchor>]'
  url: z.url({ protocol: /^https$/ }), // absolute public https URL a person can open
  title: z.string(),              // page or document title
  section: z.string(),            // section heading; '' for a page/document-level record
  crumbs: z.array(z.string()),    // breadcrumb, outermost first
  text: z.string(),               // section text (plain for site, Markdown for repo docs)
  source: DocsSourceKindSchema,   // 'adr' for site pages under adr/, else 'site'; 'repo' for component docs
  repo: z.string().optional(),    // set only when source === 'repo'; key absent otherwise
});
export type DocsRecord = z.infer<typeof DocsRecordSchema>;

export const DocsInputSchema = z.object({
  url: z.string(),                          // the URL fetched (search.json or a raw file)
  record_count: z.number().int().nonnegative(),
  last_modified: z.string().nullable(),     // ISO 8601 from Last-Modified; null when absent
  fetched_at: z.string(),                   // ISO 8601
  sha256: z.string().regex(/^[0-9a-f]{64}$/),   // of the response body (UTF-8)
});
export type DocsInput = z.infer<typeof DocsInputSchema>;

export const DocsIndexMetaSchema = z.object({
  built_at: z.string(),                     // ISO 8601
  build_commit: z.string().nullable(),      // GITHUB_SHA of this repo when built in Actions, else null
  record_count: z.number().int().nonnegative(),
  inputs: z.array(DocsInputSchema),         // config order: site first, then repos/files
});
export type DocsIndexMeta = z.infer<typeof DocsIndexMetaSchema>;

/** Records are stored grouped by input, in meta.inputs order: input i owns the next record_count records. */
export const DocsStoreSchema = z.object({
  format_version: z.literal(DOCS_FORMAT_VERSION),
  meta: DocsIndexMetaSchema,
  records: z.array(DocsRecordSchema),
});
export type DocsStore = z.infer<typeof DocsStoreSchema>;

/** Shared by the build and the loader: MiniSearch requires the same options on load. */
export const DOCS_INDEX_OPTIONS = {
  idField: 'id',
  fields: ['title', 'section', 'crumbs', 'text'],
  storeFields: [],
  extractField: (record: DocsRecord, field: string) =>
    field === 'crumbs' ? record.crumbs.join(' ') : record[field as keyof DocsRecord],
  searchOptions: { boost: { title: 3, section: 2 }, prefix: true, fuzzy: 0.2 },
} satisfies Options<DocsRecord>;
```

MiniSearch 7's default scoring is BM25+ (`bm25: { k: 1.2, b: 0.7, d: 0.5 }`), default tokenizer
and `processTerm` (lowercase, no stemming). The record store is the only copy of record fields;
the index stores none (`storeFields: []`).

### `src/docs-index/load.ts`

```ts
export interface DocsSearchHit { record: DocsRecord; score: number }

export interface DocsIndex {
  readonly meta: DocsIndexMeta;
  readonly records: readonly DocsRecord[];          // store order
  get(id: string): DocsRecord | undefined;
  /** The input (search.json or raw file) a record was built from, for provenance. */
  inputFor(id: string): DocsInput | undefined;
  /**
   * Ranked with DOCS_INDEX_OPTIONS.searchOptions over the first MAX_SEARCH_TERMS distinct terms of `query`;
   * at most `limit` (default 8) hits; RangeError unless `limit` is a positive integer. `filter` keeps only hits
   * whose record it accepts; applied inside the ranked search, before `limit`.
   */
  search(query: string, limit?: number, filter?: (record: DocsRecord) => boolean): DocsSearchHit[];
}

/** search() uses at most this many distinct query terms: each costs one prefix and one fuzzy sub-query. */
export const MAX_SEARCH_TERMS = 16;

export interface DocsIndexJson { storeJson: string; indexJson: string }

/** Parses and checks both strings. Throws Error on any mismatch; never returns a partial index. */
export function loadDocsIndex(json: DocsIndexJson): DocsIndex;
```

`loadDocsIndex`:

1. `DocsStoreSchema.parse(JSON.parse(storeJson))`; a wrong `format_version` or shape throws
   `Error('Docs index store does not match format_version 1: …')`.
2. Check `meta.record_count === records.length`, that the `inputs[].record_count` sum to it, and
   that ids are unique; build `Map<id, record>` and `Map<id, input>` by walking `inputs` in order
   over contiguous slices of `records`.
3. `MiniSearch.loadJSON<DocsRecord>(indexJson, DOCS_INDEX_OPTIONS)`; check
   `miniSearch.documentCount === records.length`, and that every store id is in the index
   (`miniSearch.has`), else `Error('Docs index and store disagree on record ids: <id> is not in the index')`.
4. `search(query, limit = 8, filter?)`: search over `boundedQuery(query)` (the first 16 distinct
   lower-cased tokens of MiniSearch's default tokenizer; constructor `searchOptions` apply),
   map each result's `id` to its record (step 3 makes every id present),
   `slice(0, limit)`, return `{ record, score }`. `limit` that is not a positive integer (0, negative,
   fractional, `NaN`, `Infinity`) throws `RangeError` before searching, so the cap cannot be
   bypassed by a caller that skips validation.

### `src/docs-index/bundled.ts`

```ts
import { DOCS_INDEX_JSON, DOCS_STORE_JSON } from '../../generated/docs-index';

let cached: DocsIndex | undefined;
/** The index bundled with this Worker build, loaded once per isolate on first use. */
export function bundledDocsIndex(): DocsIndex {
  cached ??= loadDocsIndex({ storeJson: DOCS_STORE_JSON, indexJson: DOCS_INDEX_JSON });
  return cached;
}
```

The module only holds two string constants, so isolate startup parses no JSON; the 16 ms load
happens on the first call.

### Generated module (`renderArtifactModule` output)

`generated/docs-index.js`:

```js
// Generated by scripts/build-docs-index.ts from docs-sources.yaml. Do not edit.
export const DOCS_STORE_JSON = "<JSON.stringify(JSON.stringify(store))>";
export const DOCS_INDEX_JSON = "<JSON.stringify(JSON.stringify(miniSearch))>";
```

`generated/docs-index.d.ts`:

```ts
// Generated by scripts/build-docs-index.ts. Do not edit.
export declare const DOCS_STORE_JSON: string;
export declare const DOCS_INDEX_JSON: string;
```

Each constant is a JS string literal written with `JSON.stringify(jsonString)` (valid JS since
ES2019). TypeScript resolves the extensionless import to the `.d.ts`; esbuild and Vite resolve the
`.js`. Store key order follows the schema field order above, and records are built in input order,
so the output is a pure function of the inputs plus `now` and `buildCommit`.

### Site records: `scripts/docs-index/site.ts`

```ts
/** Quarto search.json → records. Throws Error naming the first entry that does not parse. */
export function siteRecords(searchJson: unknown, siteUrl: string): DocsRecord[];
```

Each entry is parsed with
`z.looseObject({ href: z.string().min(1), title: z.string(), section: z.string(), text: z.string(), crumbs: z.array(z.string()).nullish() })`.
Record, in `search.json` order:

| Field | Value |
|---|---|
| `id` | `` `site:${href}` `` |
| `url` | `new URL(href, siteUrl).href`, which must stay on `siteUrl`'s origin and under its path (else the build throws `search.json entry <i> href leaves site_url: <href>`), e.g. `https://seandavi.github.io/bioc-infrastructure/propagation-gate.html#why-the-registry-polls` |
| `title`, `section`, `text` | entity-decoded (below), otherwise as published |
| `crumbs` | `(crumbs ?? []).map(decode)` |
| `source` | `'adr'` if `href` starts with `adr/`, else `'site'` |
| `repo` | absent |

`decode` replaces exactly `&lt;` `&gt;` `&amp;` `&quot;` `&#39;` in one pass
(`s.replace(/&(lt|gt|amp|quot|#39);/g, …)`), so `&amp;lt;` becomes `&lt;`, not `<`. Entries with
empty `text` are kept. A non-array `searchJson` throws
`Error('search.json is not an array')`; duplicate ids throw.

### Markdown records: `scripts/docs-index/markdown.ts`

```ts
export interface MarkdownDocument { owner: string; repo: string; ref: string; file: string; markdown: string }
/** One Markdown file → records split at headings of level 1–3. */
export function markdownRecords(doc: MarkdownDocument): DocsRecord[];
```

Algorithm:

1. Normalise line endings (`\r\n?` → `\n`) and split into lines.
2. Track fenced code: outside a fence, a line matching `/^ {0,3}(`{3,}|~{3,})/` opens one; inside,
   a line matching `/^ {0,3}(`{3,}|~{3,})\s*$/` with the same character and at least the same
   length closes it. Lines inside a fence (and the fence lines) are body text, never headings.
3. Outside a fence, an ATX heading is `/^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/`. Setext
   headings are not recognised. The heading's display text is the raw text with images
   `![alt](src)` → `alt`, links `[text](url)` → `text`, and every `` ` `` and `*` removed,
   then trimmed.
4. One `new GithubSlugger()` per file. **Every** ATX heading (levels 1–6, in order) gets
   `slugger.slug(displayText)`, so duplicate-anchor suffixes (`-1`, `-2`) match GitHub's.
5. Sections: the first level-1 heading is the **document title** and does not start a new
   section; it and any text before it form the document-level section. Every other heading of
   level 1, 2 or 3 starts a new section. Headings of level 4–6 stay in the body of the current
   section.
6. Section text: body lines joined with `\n`, HTML comments (`/<!--[\s\S]*?-->/g`) removed,
   trimmed. A section with empty text produces no record (its heading still appears in its
   children's crumbs).

Record for each section:

| Field | Document-level section | Other sections |
|---|---|---|
| `id` | `` `repo:${repo}/${file}` `` | `` `repo:${repo}/${file}#${anchor}` `` |
| `url` | `` `https://github.com/${owner}/${repo}/blob/${ref}/${file}` `` | same + `#${anchor}` |
| `title` | document title, or `` `${repo}/${file}` `` when the file has no level-1 heading | same |
| `section` | `''` | the heading's display text |
| `crumbs` | `[repo]`, plus the document title when it differs from `repo` | the same, plus the enclosing level-2 heading's display text for a level-3 section that has one |
| `source` | `'repo'` | `'repo'` |
| `repo` | `repo` | `repo` |

Example (Verified): `bioc-edge/DATAPLANE.md` `### Cloudflare Workflows [V]` under
`## 1. Prior art` → `id: 'repo:bioc-edge/DATAPLANE.md#cloudflare-workflows-v'`,
`crumbs: ['bioc-edge', 'A data plane for bioconductor.org', '1. Prior art']`.

### Build: `scripts/docs-index/build.ts`

```ts
export interface DocsBuildDeps {
  fetch: FetchFn;            // from src/core/deps
  now: () => Date;
  buildCommit: string | null;
}
export interface DocsIndexArtifact { store: DocsStore; storeJson: string; indexJson: string }
export interface RenderedArtifact { js: string; dts: string; bytes: number }   // bytes = UTF-8 length of js

/** Fetch every input, build records, index them. Any failure throws; there is no partial build. */
export function buildDocsIndex(config: DocsSourcesConfig, deps: DocsBuildDeps): Promise<DocsIndexArtifact>;
export function renderArtifactModule(artifact: DocsIndexArtifact): RenderedArtifact;
/**
 * Throws before writing anything if rendered.bytes > maxBytes:
 * `docs index module is <bytes> bytes; the limit is <maxBytes> (max_artifact_bytes in
 * docs-sources.yaml). Trim the corpus, or raise the limit after checking the Worker bundle with
 * npm run build.` Otherwise mkdir -p outDir and write docs-index.js and docs-index.d.ts.
 */
export function writeArtifactModule(outDir: string, rendered: RenderedArtifact, maxBytes: number): Promise<void>;
```

`buildDocsIndex`:

1. Two build-time upstreams (not registered in any `Module`, so not in `bioc://about`):
   `{ id: 'docs-site', name: 'Bioconductor infrastructure docs site', baseUrl: config.site_url, ttlSeconds: 3600, timeoutMs: 30_000, description: 'Quarto search.json of the infrastructure docs site.' }`
   and
   `{ id: 'github-raw', name: 'GitHub raw files', baseUrl: `https://raw.githubusercontent.com/${config.github_owner}/`, ttlSeconds: 3600, timeoutMs: 30_000, description: 'Component docs in the bioc-* repos.' }`.
   `deps` for `fetchUpstream`: `{ fetch: deps.fetch, cache: createMemoryCache(deps.now), now: deps.now, env: {} }`.
2. Site: `fetchUpstreamJson(…, docsSite, 'search.json')` → `siteRecords(json, config.site_url)`.
3. For each repo, for each file, in config order:
   `fetchUpstream(…, githubRaw, [repo, ref, ...file.split('/')].map(pathSegment).join('/'))` →
   `markdownRecords({ owner: config.github_owner, repo, ref, file, markdown: response.body })`.
   Inputs are fetched one at a time (16 small requests; order is then trivially deterministic).
4. Each input becomes a `DocsInput`: `url: response.url`, `record_count`,
   `last_modified: response.lastModified`, `fetched_at: response.fetchedAt`,
   `sha256: createHash('sha256').update(response.body, 'utf8').digest('hex')` (`node:crypto`).
5. Concatenate records in input order; duplicate ids throw `Error('Duplicate docs record id: <id>')`.
6. `store = { format_version: 1, meta: { built_at: deps.now().toISOString(), build_commit: deps.buildCommit, record_count, inputs }, records }`.
7. `const miniSearch = new MiniSearch<DocsRecord>(DOCS_INDEX_OPTIONS); miniSearch.addAll(records)`.
8. Return `{ store, storeJson: JSON.stringify(store), indexJson: JSON.stringify(miniSearch) }`.

A `CapabilityError` from `fetchUpstream` (404, 5xx, timeout, redirect off-base) propagates; its
message names the URL.

### Fixture fetches: `scripts/docs-index/fixtures.ts`

```ts
/**
 * Answers from files under `root`, at `<root>/<hostname>/<decoded path segments>`; a missing file
 * is a 404 Response. Content-Type is application/json for .json, text/plain otherwise; no other headers.
 * Throws on a URL whose hostname or decoded path segment is '.', '..' or contains '/' or '\\'.
 */
export function fixtureDocsFetch(root: string): FetchFn;
/**
 * Passes requests to `inner`; writes each 200 body to the fixture path for its URL (mkdir -p).
 * Refuses an unsafe URL (see fixtureDocsFetch) before calling inner.
 */
export function recordingFetch(inner: FetchFn, root: string): FetchFn;
```

The fixture path for a URL is `join(root, url.hostname, ...url.pathname.split('/').filter(Boolean).map(decodeURIComponent))`.
The hostname and each decoded path segment must not be `.` or `..` and must not contain `/` or `\`;
otherwise the path function throws (`Refusing unsafe fixture path for <url>: segment "<segment>"`).
`recordingFetch` computes the path before calling `inner`, so an unsafe URL is refused without a request.
It reads the body with `response.clone().text()` and returns the original response.

### CLI: `scripts/build-docs-index.ts`

`parseArgs` (`node:util`) options: `fixtures` (boolean), `record-fixtures` (boolean), `if-missing`
(boolean), `config` (string, default `docs-sources.yaml`), `out` (string, default `generated`).
Relative paths resolve against the repo root (`fileURLToPath(new URL('..', import.meta.url))`);
the fixture root is `<repo>/test/fixtures/docs`.

1. `--fixtures` with `--record-fixtures` → error `--fixtures and --record-fixtures cannot be combined`.
2. `--if-missing` and both `<out>/docs-index.js` and `<out>/docs-index.d.ts` exist → print
   `docs index: generated/docs-index.js exists; skipping (npm run docs:fixtures or docs:build rebuilds it)`
   and exit 0.
3. Read and `parseDocsSourcesConfig` the config (`node:fs/promises`).
4. `fetch` = `fixtureDocsFetch(root)` with `--fixtures`; otherwise `(r) => fetch(r)`, wrapped in
   `recordingFetch(…, root)` with `--record-fixtures`.
5. `buildDocsIndex(config, { fetch, now: () => new Date(), buildCommit: process.env.GITHUB_SHA ?? null })`,
   `renderArtifactModule`, `writeArtifactModule(out, rendered, config.max_artifact_bytes)`.
6. Print `docs index: <records> records from <inputs> inputs (<fixtures|network>), <bytes> bytes → <out>/docs-index.js`.

Any error: `console.error('docs index build failed: ' + message)`, `process.exitCode = 1`, and
nothing is written (writes happen only after the size check).

### Upstream calls and fixtures

All calls happen at build time (Node, in CI), never in the Worker.

| Upstream | Example URL | Fixture file |
|---|---|---|
| `docs-site` | `https://seandavi.github.io/bioc-infrastructure/search.json` | `test/fixtures/docs/seandavi.github.io/bioc-infrastructure/search.json` |
| `github-raw` | `https://raw.githubusercontent.com/seandavi/bioc-registry/main/docs/api.md` | `test/fixtures/docs/raw.githubusercontent.com/seandavi/bioc-registry/main/docs/api.md` |

The full fixture set is the 16 inputs of `docs-sources.yaml`, recorded whole (not trimmed),
about 750 KB:

```
test/fixtures/docs/seandavi.github.io/bioc-infrastructure/search.json
test/fixtures/docs/raw.githubusercontent.com/seandavi/
  bioc-registry/main/README.md            bioc-registry/main/docs/api.md
  bioc-edge/main/README.md                bioc-edge/main/DATAPLANE.md
  bioc-traffic/main/README.md             bioc-traffic/main/docs/published-comparison.md
  bioc-build/main/README.md               bioc-manifest/main/README.md
  bioc-website/main/README.md             bioc-infrastructure/main/README.md
  bioc-r-universe-build-db/main/README.md bioc-intelligence/main/README.md
  bioc-on-ice/main/README.md              bioc-harnesses/main/README.md
  bioc-mcp/main/README.md
```

Record them with `npm run docs:record` (which also builds `generated/` from the network), then
commit `test/fixtures/docs/` and the snapshot. Fixtures carry no headers, so in fixture builds
every input has `last_modified: null`.

### CI

`.github/workflows/ci.yml`: add `- run: npm run docs:fixtures` immediately after `- run: npm ci`.
PR CI then builds from fixtures explicitly; the pre-hooks find the file and skip.

`.github/workflows/docs-index.yml` (new):

```yaml
name: Docs index
on:
  schedule:
    - cron: '23 6 * * *'
  repository_dispatch:
    types: [docs-updated]
  workflow_dispatch:
permissions:
  contents: read
concurrency:
  group: docs-index
  cancel-in-progress: true
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run docs:build
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
      - uses: actions/upload-artifact@v7
        with:
          name: docs-index
          path: generated/
          retention-days: 14
```

No secrets. `docs:build` fails the job on any upstream failure or on the size limit. #11 appends
the deploy step to this job.

### AGENTS.md additions

Layout block, after `upstreams/<name>.ts`:

```
  docs-index/         docs index schemas and loader; bundled.ts imports generated/docs-index
scripts/              build-time Node code (never bundled); build-docs-index.ts builds the index
generated/            build output, gitignored: docs-index.js + docs-index.d.ts
docs-sources.yaml     the docs corpus: site URL, repos and files, size limit
```

and under `test/`: `fixtures/docs/<host>/<path>  recorded docs inputs, one file per URL`.

Rules, new bullet:

```markdown
- The docs index is built, never fetched at runtime: `scripts/build-docs-index.ts` reads
  `docs-sources.yaml`, and the Worker imports the result from `generated/`. Adding a docs source
  means editing `docs-sources.yaml`, running `npm run docs:record`, and committing the new
  fixtures and the updated snapshot (`npx vitest run -u test/docs-index`).
```

Commands, new bullets (after `npm run build`):

```markdown
- `npm run docs:fixtures`: build `generated/docs-index.js` from `test/fixtures/docs/` (no network).
  `npm test`, `typecheck`, `dev` and `build` do this first when the file is missing.
- `npm run docs:build`: build it from the live docs (network). `npm run docs:record` does the same
  and re-records `test/fixtures/docs/`.
```

## Acceptance criteria

- [ ] `npm ci && npm run typecheck && npm test && npm run build` pass on a clean checkout with no
      `generated/` directory (the pre-hooks build it from fixtures), and with the network
      disabled.
- [ ] `generated/` is gitignored; `test/fixtures/docs/` holds the 16 recorded inputs listed above.
- [ ] `npm run docs:fixtures` prints `… 16 inputs (fixtures) …` and writes
      `generated/docs-index.js` and `generated/docs-index.d.ts`.
- [ ] **Deterministic build:** `buildDocsIndex` over the fixtures with a fixed `now` and
      `buildCommit` produces byte-identical `storeJson` and `indexJson` on two runs, and the
      summary (below) matches `test/docs-index/__snapshots__/build-summary.json`.
- [ ] The fixture build has 264 records with `source` `site` or `adr`, in `search.json` order;
      every record parses with `DocsRecordSchema`; every `url` is absolute `https:`; ids are
      unique; `repo` is set exactly on `source: 'repo'` records.
- [ ] `meta.inputs` has 16 entries in config order, each `sha256` equal to the SHA-256 of the
      fixture file, `record_count`s summing to `meta.record_count`.
- [ ] **Index loads:** `loadDocsIndex` on the fixture artifact, and `bundledDocsIndex()` on the
      generated module, return an index whose `records.length === meta.record_count`;
      `bundledDocsIndex()` returns the same instance on a second call.
- [ ] **Ranking:** on the fixture index, `search('propagation gate')[0].record.id` starts with
      `site:propagation-gate.html`; `search('why does the registry poll')[0].record.id` is
      `site:propagation-gate.html#why-the-registry-polls`.
- [ ] `search(q, 3)` returns at most 3 hits; `search(q)` at most 8.
- [ ] `get('site:propagation-gate.html')` returns the page record; `inputFor` of that id returns
      the `search.json` input, and of `repo:bioc-edge/DATAPLANE.md#cloudflare-workflows-v` the
      `bioc-edge/main/DATAPLANE.md` input.
- [ ] `loadDocsIndex` throws on `format_version: 2`, on a record-count mismatch between store and
      index, on input `record_count`s that do not sum to `meta.record_count`, on a renamed record
      id, a duplicate record id, and a non-https record URL.
- [ ] **Size check:** `writeArtifactModule` with `maxBytes` one less than `rendered.bytes` throws
      the `max_artifact_bytes` message and writes nothing; with `maxBytes === rendered.bytes` it
      writes both files.
- [ ] A missing input (fixture fetch 404) makes `buildDocsIndex` reject with `not_found` naming the
      URL; a `search.json` entry without `href` makes it reject naming the entry index.
- [ ] `docs-sources.yaml` parses with `DocsSourcesConfigSchema`; the schema rejects an `http:`
      `site_url`, an unknown key, a duplicate repo, and a file not ending in `.md`.
- [ ] `ci.yml` runs `npm run docs:fixtures`; `docs-index.yml` matches the YAML above (schedule,
      `repository_dispatch` `docs-updated`, `workflow_dispatch`, `contents: read`, no secrets).
- [ ] No file under `src/core/`, `src/transports/` or `src/index.ts` changes.
- [ ] AGENTS.md has the Layout, Rules and Commands additions.
- [ ] Manual, pasted in the PR: `npm run docs:build` output (network) and the top 3 ids for
      `propagation gate` on that build.

## Test plan

All tests run in Node with Vitest and never touch the network: builds use `fixtureDocsFetch`
over `test/fixtures/docs/`, or `fixtureFetch` from `test/support/` where a test needs a header or
an error status. A shared helper in `test/docs-index/build.test.ts` builds once with
`now = () => new Date('2026-10-22T00:00:00Z')` and `buildCommit = 'test-commit'`, reading the real
`docs-sources.yaml`.

| File | Covers |
|---|---|
| `test/docs-index/config.test.ts` | the committed `docs-sources.yaml` parses; rejections: `http:` `site_url`, `site_url` without trailing `/`, unknown key, duplicate repo, `files: ['notes.txt']`, empty `repos` |
| `test/docs-index/site.test.ts` | field mapping on a two-entry inline array (one `adr/`, one not); absolute URLs; entity decoding including `&amp;lt;` → `&lt;`; `crumbs: null` → `[]`; non-array input throws; an entry missing `href` throws naming index 1; duplicate `href` throws; hrefs that leave `site_url` (`https://other.example/x`, `//other.example/x`, `javascript:alert(1)`, `../x.html`) throw |
| `test/docs-index/markdown.test.ts` | inline Markdown strings: document-level record from preamble + first `#`; `##`/`###` split, `####` kept in body; `#` inside a fenced block (backtick and tilde) ignored; duplicate headings get `-1`; link/code/emphasis stripped from section and anchor; empty sections skipped but named in children's crumbs; no `#` → title `repo/file`; CRLF input; crumbs drop a title equal to the repo; the `bioc-edge/DATAPLANE.md` fixture yields `repo:bioc-edge/DATAPLANE.md#cloudflare-workflows-v` with the crumbs in the example |
| `test/docs-index/build.test.ts` | byte-identical rebuild; `toMatchFileSnapshot('./__snapshots__/build-summary.json')` of `JSON.stringify({ meta, store_sha256, index_sha256, records: records.map(({ text, ...rest }) => ({ ...rest, text_chars: text.length })) }, null, 2)`; 264 site/adr records; input sha256s equal the fixture files' hashes; `last_modified` comes through when `search.json` is served by `fixtureFetch` with a `last-modified` header; missing fixture → rejects `not_found`; `renderArtifactModule` output imports back (write to a temp dir, `import()` it, `loadDocsIndex` the constants); `writeArtifactModule` size limit at `bytes - 1` / `bytes` (temp dir via `mkdtemp`) |
| `test/docs-index/load.test.ts` | ranking for the two queries; `limit` (0, negative, 2.5, `NaN`, `Infinity` throw `RangeError`); the 16-distinct-term bound; `get`; `inputFor` for a site and a repo id; throws on `format_version: 2`, a dropped record, bad input counts, a renamed id, a duplicate id, and `javascript:` / `http:` record URLs |
| `test/docs-index/fixtures.test.ts` | `recordingFetch` and `fixtureDocsFetch` refuse `..%2F`, `..%5C` and `https://../x` URLs (no `inner` call, nothing written); a safe URL is written under `<root>/<host>/<path>` and read back |
| `test/docs-index/bundled.test.ts` | `bundledDocsIndex()` loads `generated/docs-index` (whatever build is present), `DocsIndexMetaSchema` parses its `meta`, records are non-empty, the same instance is returned twice. No ranking assertion, because a local `docs:build` may have replaced the fixture build |

Manual, reported in the PR: `npm run docs:build` against the live sources, and the top 3 ids for
`propagation gate`.

## Risks

- **Bundle size.** The index adds about 400 KiB gzip to the Worker once #4 imports it (647 KiB
  gzip total, Verified), well under the 3 MB free-plan limit. `max_artifact_bytes` (4 MB raw, about
  2.4× today) fails the build before the bundle limit is near; `npm run build` in the docs
  workflow is the second check.
- **No ETag or commit per input.** `fetchUpstream` returns `lastModified` but not `ETag`, and
  `raw.githubusercontent.com` sends no `Last-Modified`. Changing the shared upstream seam for one
  build script is not worth it, so each input records the body's `sha256` (deterministic,
  fixture-testable, and answers "did it change") plus `last_modified` where the upstream sends one
  and `fetched_at`. `build_commit` is this repo's `GITHUB_SHA`. If #4 wants upstream commits, the
  GitHub commits API can be added to the build then.
- **Workflows on the default branch only.** `schedule` and `repository_dispatch` run only from
  `main`, so `docs-index.yml` is first exercised after merge; run it once by hand
  (`workflow_dispatch`) after merging.
- **Stale fixtures fail PR CI by design.** A new file in `docs-sources.yaml` without a recorded
  fixture is a 404 in fixture mode and fails `docs:fixtures`. The AGENTS.md rule says to run
  `npm run docs:record`.
- **Markdown splitting is a subset of CommonMark** (ATX headings, backtick and tilde fences;
  no setext headings, no headings inside HTML blocks). It matches GitHub's anchors on every file in
  the corpus today (Verified for two files with the hardest headings; the snapshot pins the rest).
  A wrong anchor still lands on the right file.
- **Ranking is unmeasured beyond three queries.** No stemming means `redirects` does not match
  `redirect` exactly (`fuzzy: 0.2` partly covers it). #5's recall@5 set decides whether to add a
  stemmer or change boosts; both live in `DOCS_INDEX_OPTIONS`, and `processTerm` changes require a
  rebuild, which the snapshot will show.
- **Pre-hooks only run through npm.** `npx vitest` or `npx tsc` on a fresh clone fail with "Cannot
  find module '../../generated/docs-index'" until `npm run docs:fixtures` runs once. The AGENTS.md
  Commands section says so.
