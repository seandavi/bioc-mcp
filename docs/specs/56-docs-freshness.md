# Spec #56: Freshness of docs results (source commit, age, possibly stale)

Issue: [seandavi/bioc-mcp#56](https://github.com/seandavi/bioc-mcp/issues/56), part of #48 (tester
feedback). It builds on [Spec #3](3-docs-index.md) (the index), [Spec #4](4-docs-module.md)
(`docs_search`, `docs_read`, `bioc://about` datasets) and [Spec #61](61-docs-ranking.md).
Project design: [proposal-mcp.qmd](https://github.com/seandavi/bioc-infrastructure/blob/spec/mcp/proposal-mcp.qmd).
Conventions: [AGENTS.md](../../AGENTS.md).

Checked on 2026-10-22 against `main` at `800477e` (`npm ci`; zod 4.6.7, minisearch 7.2.0 as locked).
There, `npm test` passes (59 files, 1179 tests), and `npm run eval:docs` reports recall@1 0.765
(26/34), recall@5 0.912 (31/34) and MRR@10 0.810. **Verified** marks what curl, `gh` or a throwaway
script in `/tmp` showed on that date:

- **Verified:** the live `search.json` has `Last-Modified: Fri, 16 Oct 2026 23:22:32 GMT`.
  `raw.githubusercontent.com` sends no `Last-Modified` (only `ETag`), so every repo input's
  `as_of` today is the build's `fetched_at`.
- **Verified:** the site is published by the `docs.yml` workflow in seandavi/bioc-infrastructure
  (`on: push: branches: [main]` with no path filter, plus `workflow_dispatch`) through Pages
  deployments. `GET /repos/seandavi/bioc-infrastructure/pages` reports `"build_type":"workflow"`.
  `GET https://api.github.com/repos/seandavi/bioc-infrastructure/deployments?environment=github-pages&per_page=10`
  returns 10 deployments, newest first (49,423 bytes). The newest is id `7131578958`, sha
  `256fd62eab16312a6188bef6bf74ea2bbab5f830`, ref `main`, created `2026-10-16T23:22:24Z`.
- **Verified:** `GET …/deployments/7131578958/statuses?per_page=1` returns one status, the newest,
  `{"state":"success","created_at":"2026-10-16T23:22:39Z"}`. The full list is newest first:
  `success`, `in_progress`, `queued`, `waiting`. The previous deployment (`7131140387`, `223af2a`)
  still has `success` as its newest status: Pages deployments made by Actions are **not** marked
  `inactive` when a newer one succeeds. So the live deployment is the newest one whose newest
  status is `success`.
- **Verified:** `GET https://api.github.com/repos/seandavi/bioc-infrastructure/branches/main`
  (7,257 bytes, no `files` list) gives `commit.sha` `256fd62…` and
  `commit.commit.committer.date` `2026-10-16T23:21:08Z`. `GET …/commits/main` gives the same sha
  but runs to 27,655 bytes because it includes the commit's files and patches. `GET
  …/compare/256fd62…main` reports `"status":"identical","ahead_by":0`.
- **Verified, and this changes the issue's premise:** the site is old (2026-10-16) but **not
  stale**. Its deployed commit is still the head of bioc-infrastructure `main`; nothing has merged
  since. A flag based only on "input older than N days" would mark current docs as stale. So this
  spec flags an input as possibly stale when **its source commit is behind its branch head**, which
  is a real signal: `docs.yml` deploys on every push to `main`, so being behind means a deploy
  failed or was still running. The age rule applies only to an input whose commit is unknown, and
  to the index itself, which should rebuild daily.
- **Verified:** unauthenticated GitHub API calls are limited to 60 per hour per IP
  (`x-ratelimit-limit: 60`). The build makes about 14 GitHub API calls (below).
- **Verified:** today's `docs_search` envelopes for the 34 eval questions at `limit: 10` are 6,650 to
  8,155 bytes (median 7,865). Nine questions already drop one hit for size. One hit costs about
  800 bytes.

No new npm package, MCP tool or REST route. There is one new kind of build-time upstream call (the
GitHub REST API, through the existing adapter in `src/upstreams/github.ts`), with 14 new fixture
files. The docs store format goes from 1 to 2.

## Goal

A docs result says what it was built from and whether it might be out of date:

1. The index records each input's **source commit** at build time. For a bioc-* repo file, that is
   the head of the configured branch. For the infrastructure site, it is the commit of the live
   GitHub Pages deployment. The index also records the head of that commit's branch.
2. `docs_search` gives each hit's `as_of` and `source_commit` in `data`. Its summary gives each
   hit's as-of date and short commit, the index build date and any "possibly stale" warnings.
3. `docs_read` gives the read page's `as_of`, `source_commit` and the same freshness block. Its
   summary states them.
4. `bioc://about` and `GET /api/v1/about` give the docs-index dataset's age and warnings, and each
   input's commit (with a GitHub URL) and warning.

"Possibly stale" has exactly three rules:

- **Index age:** `now − meta.built_at ≥ 2 days`. The Deploy workflow rebuilds daily, so this means
  at least one rebuild failed or did not run.
- **Behind its branch:** `input.commit !== null && input.commit.sha !== input.commit.head_sha`.
- **Unknown commit and old:** `input.commit === null && now − as_of ≥ 14 days`.

## Non-goals

- No new tool. The issue left the name open. Freshness belongs to results that already exist, so
  it goes into `docs_search`, `docs_read` and the about document.
- No runtime calls to GitHub from the docs module. Commits are looked up at build time only. The
  docs module keeps `upstreams: []`. `docs_*` stay offline at runtime, and their staleness rules
  use only `meta` and `deps.now()`.
- No change to `as_of` itself (`docsSource`: `last_modified ?? fetched_at`) or to `sources`.
- No change to ranking, the record split or record ids/URLs. Raw files are still fetched by ref,
  not by sha (see Risks).
- No change to the `bioc://docs/{+path}` resource text or the `explain-decision` prompt.
- No bioc-infrastructure change. The issue's suggested issue about why the site has not
  republished does not apply: it has not republished because `main` has not moved (verified
  above). File no such issue.
- No re-recording of the content fixtures (search.json, page HTML, raw files). Only the new
  `api.github.com` fixtures are added (see [Fixtures](#fixtures)).

## Design

### Files

| File | Change |
|---|---|
| `src/docs-index/schema.ts` | `DOCS_FORMAT_VERSION = 2`; `DocsInputCommitSchema`; `DocsInputSchema.commit` |
| `src/upstreams/github.ts` | `getBranch`, `listDeployments`, `listDeploymentStatuses` and their schemas |
| `scripts/docs-index/commits.ts` (new) | `branchCommit`, `pagesCommit` (build time) |
| `scripts/docs-index/build.ts` | `DocsBuildDeps.env`; record `commit` on every input |
| `scripts/docs-index/config.ts` | `github_owner: z.literal('seandavi')`; new `site_repo` |
| `scripts/docs-index/fixtures.ts` | URLs with a query string map to one extra path segment |
| `scripts/build-docs-index.ts`, `scripts/eval-docs.ts` | pass `env` |
| `docs-sources.yaml` | `site_repo: bioc-infrastructure` and comments |
| `src/core/docs/freshness.ts` (new) | constants, age and warning functions, `DocsFreshnessSchema` |
| `src/core/docs/search.ts` | hit `as_of`, `source_commit`; `data.freshness`; summary |
| `src/core/docs/read.ts` | `as_of`, `source_commit`, `freshness`; summary |
| `src/core/docs/index.ts` | `datasets(now)` with age, warnings and commits |
| `src/core/about.ts` | `DatasetCommitSchema`, `DatasetInputSchema`, dataset `age_days`, `possibly_stale`; `buildAbout(modules, now)` |
| `src/core/capability.ts` | `BundledDataset` fields; `datasets?: (now: Date) => BundledDataset[]` |
| `src/transports/mcp.ts`, `src/transports/rest.ts` | `buildAbout(…, deps.now())` |
| `.github/workflows/deploy.yml` | `GITHUB_TOKEN: ${{ github.token }}` on the `npm run docs:build` step |
| `docs/deploy.md`, `AGENTS.md` | one sentence each (below) |
| `test/fixtures/docs/api.github.com/…` | 14 new fixture files |
| tests | see [Test plan](#test-plan) |

### 1. Stored commit (`src/docs-index/schema.ts`)

```ts
export const DOCS_FORMAT_VERSION = 2;

const CommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);

export const DocsInputCommitSchema = z.object({
  repo: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/), // 'seandavi/bioc-registry'
  ref: z.string().min(1), // branch the input follows: docs-sources.yaml ref, or the Pages deployment's ref
  sha: CommitShaSchema, // commit the input was built from
  head_sha: CommitShaSchema, // head of ref when the index was built; equals sha for repo files
  head_committed_at: z.string(), // ISO 8601 committer date of head_sha, as GitHub sends it
});
export type DocsInputCommit = z.infer<typeof DocsInputCommitSchema>;

export const DocsInputSchema = z.object({
  url: z.string(),
  record_count: z.number().int().nonnegative(),
  last_modified: z.string().nullable(),
  fetched_at: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  commit: DocsInputCommitSchema.nullable(), // null only for the site when no live Pages deployment is found
});
```

`loadDocsIndex` needs no change. A format-1 store fails `z.literal(2)` with the existing message.
The bundled artifact is always rebuilt with the code, so the bump costs nothing at deploy.

### 2. GitHub adapter additions (`src/upstreams/github.ts`)

These are added next to the existing functions and use the private `githubJson`, which adds the
headers and the token and maps errors. `Fetched<T>` stays unexported; the return types below spell
it out.

```ts
export const GithubBranchSchema = z.object({
  name: z.string(),
  commit: z.object({
    sha: z.string().regex(/^[0-9a-f]{40}$/),
    commit: z.object({ committer: z.object({ date: z.string() }) }),
  }),
});
export type GithubBranch = z.infer<typeof GithubBranchSchema>;

/** GET /repos/seandavi/<repo>/branches/<branch>: the head commit without its file list. */
export async function getBranch(deps: Deps, repo: string, branch: string): Promise<Fetched<GithubBranch>>;
// path `${pathSegment(repo)}/branches/${pathSegment(branch)}`, what 'branch'

export const GithubDeploymentSchema = z.object({
  id: z.number().int(),
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  ref: z.string(),
  created_at: z.string(),
});
export type GithubDeployment = z.infer<typeof GithubDeploymentSchema>;

/** Deployments to `environment`, newest first. */
export async function listDeployments(
  deps: Deps, repo: string, environment: string, perPage: number,
): Promise<Fetched<GithubDeployment[]>>;
// path `${pathSegment(repo)}/deployments?environment=${encodeURIComponent(environment)}&per_page=${perPage}`,
// schema z.array(GithubDeploymentSchema), what 'deployment list'

export const GithubDeploymentStatusSchema = z.object({ state: z.string() }); // 'success', 'failure', 'in_progress', …
export type GithubDeploymentStatus = z.infer<typeof GithubDeploymentStatusSchema>;

/** Statuses of one deployment, newest first. */
export async function listDeploymentStatuses(
  deps: Deps, repo: string, id: number, perPage: number,
): Promise<Fetched<GithubDeploymentStatus[]>>;
// path `${pathSegment(repo)}/deployments/${pathSegment(String(id))}/statuses?per_page=${perPage}`,
// schema z.array(GithubDeploymentStatusSchema), what 'deployment status list'
```

Upstream calls with example URLs (`githubUpstream`, base `https://api.github.com/repos/seandavi/`):

| Call | Example URL |
|---|---|
| `getBranch(deps, 'bioc-registry', 'main')` | `https://api.github.com/repos/seandavi/bioc-registry/branches/main` |
| `listDeployments(deps, 'bioc-infrastructure', 'github-pages', 10)` | `https://api.github.com/repos/seandavi/bioc-infrastructure/deployments?environment=github-pages&per_page=10` |
| `listDeploymentStatuses(deps, 'bioc-infrastructure', 7131578958, 1)` | `https://api.github.com/repos/seandavi/bioc-infrastructure/deployments/7131578958/statuses?per_page=1` |

`githubUpstream` is not added to the docs module's `upstreams`, because the Worker never makes
these calls. `test/upstreams/imports.test.ts` already allows this file's imports.

### 3. Commit lookups at build time (`scripts/docs-index/commits.ts`, new)

```ts
import type { Deps } from '../../src/core/deps';
import type { DocsInputCommit } from '../../src/docs-index/schema';
import { getBranch, listDeployments, listDeploymentStatuses } from '../../src/upstreams/github';

export const PAGES_ENVIRONMENT = 'github-pages';
/** pagesCommit looks at most this many deployments back for the live one. */
export const MAX_PAGES_DEPLOYMENTS = 10;

/** The head of seandavi/<repo>@<ref>, as stored for a repo file: sha === head_sha. */
export async function branchCommit(deps: Deps, repo: string, ref: string): Promise<DocsInputCommit>;
// { repo: `seandavi/${repo}`, ref, sha: b.commit.sha, head_sha: b.commit.sha,
//   head_committed_at: b.commit.commit.committer.date } where b = (await getBranch(deps, repo, ref)).data

/**
 * The commit the live GitHub Pages site of seandavi/<repo> was deployed from: the newest of the
 * newest MAX_PAGES_DEPLOYMENTS 'github-pages' deployments whose newest status is 'success'
 * (listDeploymentStatuses(…, 1)[0]?.state), checked newest first and stopping at the first match.
 * head_sha and head_committed_at come from getBranch(deps, repo, deployment.ref). Returns null when
 * no deployment qualifies, without calling getBranch.
 */
export async function pagesCommit(deps: Deps, repo: string): Promise<DocsInputCommit | null>;
```

Deployments are scanned in the order the API returns them (newest first, verified). A
`CapabilityError` from any call is thrown out of the build. As today, there is no partial build.
A `deployment.ref` containing `/` makes `pathSegment` throw `invalid_input`, which also fails the
build. Today's ref is `main`.

### 4. Build (`scripts/docs-index/build.ts`, `config.ts`, `docs-sources.yaml`)

`DocsBuildDeps` gains `env: CapabilityEnv` (from `src/core/deps.ts`). `fetchDeps` uses
`env: deps.env` in place of `{}`, so `githubJson` sends `Authorization: Bearer …` when a token is
set.

`inputFor(response, recordCount, commit: DocsInputCommit | null): DocsInput` adds `commit`.
`add(response, records, commit)` passes it through.

Order of fetches:

1. `search.json` (unchanged), then `const siteCommit = await pagesCommit(fetchDeps, config.site_repo)`,
   then the page HTML (unchanged). The site input is `add(site.response, …, siteCommit)`.
2. For each `{ repo, ref, files }`, first `const commit = await branchCommit(fetchDeps, repo, ref)`,
   then the files. Each file input gets that `commit`.

`bioc-infrastructure/branches/main` is requested twice: once for the site head, once for the repo
input. The build's memory cache (`githubUpstream.ttlSeconds` 120) serves the second request, and
both read the same fixture file.

Config (`DocsSourcesConfigSchema`):

```ts
github_owner: z.literal('seandavi'), // commit lookups go through src/upstreams/github.ts, which reads only seandavi/*
site_repo: z.string().regex(segment), // the repo whose GitHub Pages deployments publish site_url
```

`docs-sources.yaml` gains this, after `site_url`:

```yaml
# The seandavi/* repo whose GitHub Pages deployments publish site_url; the build records the commit
# of the live deployment, and the head of its branch, as the site input's source commit.
site_repo: bioc-infrastructure
```

Its `github_owner` comment gains: "Must be seandavi: the build looks up each repo's branch head
through the GitHub adapter, which reads only seandavi/* repos."

Scripts: `scripts/build-docs-index.ts` passes `env: values.fixtures ? {} : { GITHUB_TOKEN: process.env.GITHUB_TOKEN }`,
and `scripts/eval-docs.ts` passes `env: values.network ? { GITHUB_TOKEN: process.env.GITHUB_TOKEN } : {}`.
`test/docs-index/support.ts` passes `env: {}`.

`.github/workflows/deploy.yml`, step `- run: npm run docs:build`, gains:

```yaml
        env:
          GITHUB_TOKEN: ${{ github.token }}  # rate limit only: the build reads public seandavi/* repos
```

`docs/deploy.md` gains one sentence where it describes the docs rebuild: "The docs build looks up
each docs input's source commit with the GitHub REST API (about 14 calls), authenticated with the
workflow's own `github.token` only to avoid the 60-per-hour anonymous limit."

In `AGENTS.md`, the docs-index rule gains, after the sentence about page HTML: "It also records each
input's source commit (a repo's branch head; the site's live Pages deployment) through the GitHub
adapter; those responses are fixtures under `test/fixtures/docs/api.github.com/`."

### 5. Fixtures (`scripts/docs-index/fixtures.ts`) {#fixtures}

The fixture path is `<root>/<hostname>/<decoded path segments>`. That cannot hold both
`…/deployments` (a file) and `…/deployments/<id>/statuses` (under a directory of the same name).
New rule: **a URL with a non-empty `search` gets one more segment, `encodeURIComponent(url.search)`**.
The unsafe-segment check applies to it too. No existing fixture URL has a query string, so no
existing fixture moves. The doc comments of `fixtureDocsFetch` and `recordingFetch` say this.

New fixture files (14), recorded from the live API on the implementation date. Only the response
body is written, so the token never reaches a fixture.

```
test/fixtures/docs/api.github.com/repos/seandavi/bioc-infrastructure/deployments/%3Fenvironment%3Dgithub-pages%26per_page%3D10
test/fixtures/docs/api.github.com/repos/seandavi/bioc-infrastructure/deployments/<live id>/statuses/%3Fper_page%3D1
test/fixtures/docs/api.github.com/repos/seandavi/<repo>/branches/main   (12 files, one per repo in docs-sources.yaml)
```

`pagesCommit` walks newest first. If the newest deployment is not the live one when recording,
there is one `statuses` file per deployment it checked, and the count is more than 14.

Recording only these: run `npm run docs:record`. Then restore the content fixtures with
`git checkout -- test/fixtures/docs/seandavi.github.io test/fixtures/docs/raw.githubusercontent.com`
and run `git status --short test/fixtures/docs` to check that only `api.github.com/` files are new.
This keeps search.json, the HTML and the raw files as they are. The eval then compares like with
like, and no section an eval question names can disappear. As a consequence, the fixture repo
heads can postdate some fixture file contents. No test compares them (see Risks).

Then `npm run docs:fixtures` and `npx vitest run -u test/docs-index`. The snapshot diff must show
only `commit` objects added to the 16 inputs.

### 6. Freshness (`src/core/docs/freshness.ts`, new)

```ts
import * as z from 'zod';
import type { DocsIndexMeta, DocsInput } from '../../docs-index/schema';
import { docsSource } from './pages';

/** The Deploy workflow rebuilds the index daily; at this age at least one rebuild failed or did not run. */
export const DOCS_INDEX_STALE_AFTER_DAYS = 2;
/** An input whose source commit is unknown is possibly stale at this age (of its as_of). */
export const DOCS_INPUT_STALE_AFTER_DAYS = 14;

const DAY_MS = 86_400_000;

/** Whole days from `timestamp` to `now`, rounded down; 0 if `timestamp` is in the future or unparseable. */
export function ageDays(timestamp: string, now: Date): number;

/**
 * The URL every page built from `input` starts with: for a raw.githubusercontent.com file, its GitHub blob URL
 * (https://github.com/<owner>/<repo>/blob/<ref>/<path>, as scripts/docs-index/markdown.ts links it); otherwise the
 * directory of the input URL (the site root for search.json).
 */
export function inputPagesUrl(input: DocsInput): string;

/** null unless ageDays(meta.built_at, now) >= DOCS_INDEX_STALE_AFTER_DAYS; then INDEX_WARNING below. */
export function indexStaleWarning(meta: DocsIndexMeta, now: Date): string | null;

/** null, or the BEHIND or UNKNOWN warning below (BEHIND is checked first). */
export function inputStaleWarning(input: DocsInput, now: Date): string | null;

/** 'as of <YYYY-MM-DD>' or 'as of <YYYY-MM-DD>, commit <sha 7>': docsSource(input).as_of.slice(0, 10), commit.sha.slice(0, 7). */
export function inputNote(input: DocsInput): string;

export const DocsFreshnessSchema = z.object({
  index_built_at: z.string().describe('When the docs index was built (ISO 8601); it is rebuilt daily'),
  index_age_days: z.number().int().nonnegative().describe('Whole days since index_built_at'),
  possibly_stale: z
    .array(z.string())
    .describe(
      'Why this result may be out of date: the index is 2+ days old, a source was behind its branch, or a ' +
        "source's commit is unknown and it is 14+ days old. A source's warning starts with the URL its pages " +
        'start with; [] when none',
    ),
});
export type DocsFreshness = z.output<typeof DocsFreshnessSchema>;

/**
 * index_built_at = meta.built_at; index_age_days = ageDays(meta.built_at, now); possibly_stale =
 * indexStaleWarning (if any), then inputStaleWarning of each distinct input in `inputs` (by url,
 * first-appearance order), nulls dropped.
 */
export function docsFreshness(meta: DocsIndexMeta, inputs: readonly DocsInput[], now: Date): DocsFreshness;
```

Warning texts are exact. `<date>` means the first 10 characters of an ISO string, `<sha7>` the
first 7 of a sha, and `<n>` an integer:

- INDEX_WARNING: `The docs index was built <built_at date>, <n> days ago; it is rebuilt daily, so docs changed since then are not in it.`
- BEHIND: `Docs under <inputPagesUrl(input)> come from <repo>@<sha7>, but <ref> was already at <head_sha7> (committed <head_committed_at date>) when the index was built; they may lag <ref>.`
- UNKNOWN: `Docs under <inputPagesUrl(input)> are <n> days old (as of <as_of date>) and their source commit is unknown.`
  `<n>` here is `ageDays(docsSource(input).as_of, now)`, and the rule fires at `n >= 14`.

### 7. `docs_search` (`src/core/docs/search.ts`)

The input schema is unchanged. MCP tool `docs_search` and REST `GET /api/v1/docs/search` are as
today. The output only gains fields. Two fields are added to `DocsSearchHitSchema`, after `score`:

```ts
as_of: z.string().describe("When this hit's source was current (ISO 8601): the site's publish time or the build's fetch time"),
source_commit: z.string().nullable().describe('Commit (40-hex sha) of the bioc-* repo or published site this hit was built from; null when unknown'),
```

`DocsSearchDataSchema` gains `freshness: DocsFreshnessSchema` after `omitted_for_size`.

Handler: `async handler({ query, limit, source }, deps)`. Per hit, `input = pages.pageOf(record)!.input`.
Then `as_of = docsSource(input).as_of` and `source_commit = input.commit?.sha ?? null`. Inside
`build(kept)`, `freshness = docsFreshness(index.meta, keptInputs, deps.now())`, where
`keptInputs` are the inputs of the first `kept` hits. The existing 8 KB trim loop is unchanged:
dropping a hit can also drop its input's warning.

`describeHits(query, source, hits, omitted, inputs: DocsInput[] /* per kept hit */, freshness)`. The
summary is:

- **Hits:** each line becomes `\n<i>. <title>[ › <section>] <url> (<inputNote(input)>)`. After the
  lines comes `\nIndex built <index_built_at date> (<n> day[s] old).` (`1 day`, otherwise `days`;
  `0 days old` today). Then `\nPossibly stale: <warning>` for each `freshness.possibly_stale`.
  Then the existing "dropped" line, unchanged and last.
- **No hits:** the existing text, then `\nPossibly stale: <warning>` for each
  `freshness.possibly_stale` (only the index warning can be there).

Example: `query: "propagation gate", limit: 2` on the fixture index, with `now` set to the build
time. The hit lines come from today's code. The suffixes and the last line are what this spec
adds, using the live deployment sha.

```
2 docs sections for "propagation gate":
1. The propagation gate: what bioc-registry publishes, and why › The gate, check by check https://seandavi.github.io/bioc-infrastructure/propagation-gate.html#the-gate-check-by-check (as of 2026-10-22, commit 256fd62)
2. The propagation gate: what bioc-registry publishes, and why › Relation to the legacy production gate https://seandavi.github.io/bioc-infrastructure/propagation-gate.html#relation-to-the-legacy-production-gate (as of 2026-10-22, commit 256fd62)
Index built 2026-10-22 (0 days old).
```

(Fixtures have no `Last-Modified`, so the site's `as_of` there is `fetched_at`. Live, it is
2026-10-16.)

The description gains one sentence at the end: "Each hit carries as_of and source_commit; freshness
says when the index was built and lists any reason a hit may be out of date."

### 8. `docs_read` (`src/core/docs/read.ts`)

The input is unchanged. MCP tool `docs_read` and REST `GET /api/v1/docs/read` are as today.
`DocsReadDataSchema` gains these fields after `repo`:

```ts
as_of: z.string().describe("When the page's source was current (ISO 8601)"),
source_commit: z.string().nullable().describe('Commit (40-hex sha) the page was built from; null when unknown'),
freshness: DocsFreshnessSchema,
```

Handler: `async handler({ id_or_url, cursor }, deps)`. Set `input = page.input`, then
`as_of = docsSource(input).as_of`, `source_commit = input.commit?.sha ?? null` and
`freshness = docsFreshness(index.meta, [input], deps.now())`. `envelopeOf` sets all three, so the
skeleton and text budget account for them without other changes.

`readSummary` appends ` <inputNote(input)>, capitalised.` and then ` Possibly stale: <warning>` for
each warning. Illustrative (the lengths are made up): `"The propagation gate: what bioc-registry publishes, and why" (https://seandavi.github.io/bioc-infrastructure/propagation-gate.html), full text, 5120 characters. As of 2026-10-16, commit 256fd62.`
and `"…", characters 1–7000 of 12000. Call docs_read again with cursor "7000" for the rest. As of 2026-10-22, commit 5d4c642.`

### 9. About (`src/core/about.ts`, `src/core/capability.ts`, `src/core/docs/index.ts`, transports)

```ts
// about.ts
export const DatasetCommitSchema = z.object({
  repo: z.string(), // 'seandavi/bioc-infrastructure'
  ref: z.string(),
  sha: z.string(), // its page is https://github.com/<repo>/commit/<sha>
  head_sha: z.string(), // head of ref when the dataset was built
  head_committed_at: z.string(),
});
export const DatasetInputSchema = SourceSchema.extend({
  commit: DatasetCommitSchema.nullable(),
  possibly_stale: z.string().nullable(), // the warning for this input; null when none
});
export type DatasetInput = z.infer<typeof DatasetInputSchema>;
// datasets[] item: id, module, description, built_at, build_commit,
//   age_days: z.number().int().nonnegative(), possibly_stale: z.array(z.string()), inputs: z.array(DatasetInputSchema)

export function buildAbout(modules: readonly Module[], now: Date): About; // calls module.datasets?.(now)
```

```ts
// capability.ts
export interface BundledDataset {
  id: string;
  description: string;
  built_at: string;
  build_commit: string | null;
  age_days: number; // whole days since built_at
  possibly_stale: string[]; // every warning for the dataset and its inputs; [] when none
  inputs: DatasetInput[]; // import type { DatasetInput } from './about'
}
// Module: datasets?: (now: Date) => BundledDataset[];
```

`createDocsModule(...).datasets(now)` returns, for `meta = getIndex().meta`:

```ts
{
  id: 'docs-index',
  description: /* unchanged text */ + ' Each input lists its source commit; possibly_stale says why it may be out of date.',
  built_at: meta.built_at,
  build_commit: meta.build_commit,
  age_days: ageDays(meta.built_at, now),
  possibly_stale: docsFreshness(meta, meta.inputs, now).possibly_stale,
  inputs: meta.inputs.map((input) => ({
    ...docsSource(input),
    commit: input.commit && { repo, ref, sha, head_sha, head_committed_at }, // from input.commit, in this key order; no url
    possibly_stale: inputStaleWarning(input, now),
  })),
}
```

`src/transports/mcp.ts` uses `buildAbout(all, deps.now())`. `src/transports/rest.ts` uses
`buildAbout(modules, deps.now())`. The bioc://about resource and `GET /api/v1/about` still return
the same JSON. The OpenAPI document picks up the schema change through `AboutSchema`.

## Acceptance criteria

- [ ] `DOCS_FORMAT_VERSION` is 2. Every `meta.inputs[]` has `commit` matching `DocsInputCommitSchema`
      or null. `loadDocsIndex` rejects a format-1 store.
- [ ] A fixture build (`npm run docs:fixtures`) gives the site input
      `commit.repo === 'seandavi/bioc-infrastructure'`, `ref === 'main'`, with `sha` equal to the
      recorded live deployment's sha and `head_sha`/`head_committed_at` from the recorded
      `branches/main`. Every repo input has `commit.repo === 'seandavi/<repo>'`,
      `ref` equal to its docs-sources.yaml `ref`, and `sha === head_sha`.
- [ ] `pagesCommit` skips deployments whose newest status is not `success`. It returns null without
      calling `getBranch` when none of the first 10 qualifies.
- [ ] A build whose GitHub call fails (404 fixture, 403 rate limit, schema mismatch) throws.
      Nothing is written.
- [ ] `docs-sources.yaml` without `site_repo`, or with `github_owner` other than `seandavi`, fails
      `parseDocsSourcesConfig`.
- [ ] A fixture URL with a query string reads and records at `<path>/<encodeURIComponent(search)>`.
      Every existing fixture path is unchanged (`git status` shows only additions under
      `api.github.com/`).
- [ ] With `GITHUB_TOKEN` in `deps.env`, the build's GitHub requests carry
      `authorization: Bearer <token>`. Raw and site requests do not.
- [ ] `docs_search` hits have `as_of` and `source_commit`, and `data.freshness` is present. The
      summary lines end with `(as of YYYY-MM-DD[, commit abcdef1])` and are followed by
      `Index built YYYY-MM-DD (N days old).`
- [ ] With `deps.now()` 2 days after `built_at`, the INDEX warning text is in
      `data.freshness.possibly_stale` and the summary of `docs_search` (hits and no hits) and of
      `docs_read`, and in `bioc://about`. At 1 day 23 hours 59 minutes it is in none of them.
- [ ] An input with `sha !== head_sha` makes the BEHIND warning appear in `docs_search` only when a
      kept hit comes from it. It also appears in `docs_read` of its pages and in that about input's
      `possibly_stale`. An input with `commit: null` gets the UNKNOWN warning at 14 days, not at 13.
      An input with `sha === head_sha` gets none at any age.
- [ ] `bioc://about` and `GET /api/v1/about` return identical JSON. The docs-index dataset has
      `age_days`, `possibly_stale` and 16 inputs, each with `commit` (no `url`) and
      `possibly_stale`. `AboutSchema.parse` accepts it.
- [ ] Every `docs_search` and `docs_read` result is still ≤ 8192 bytes (`assertEnvelopeSize`).
      `npm run eval:docs` shows recall@1 0.765 and recall@5 0.912 unchanged. MRR@10 is reported
      before and after in the PR, along with the total `omitted_for_size` over the 34 questions.
- [ ] `npm test`, `npm run typecheck` and `npm run build` pass. No test touches the network.
- [ ] `.github/workflows/deploy.yml` passes `GITHUB_TOKEN: ${{ github.token }}` to `npm run docs:build`
      only. `ci.yml` is unchanged.

## Test plan

New:

- `test/core/docs/freshness.test.ts`: `ageDays` (floor, future → 0, garbage → 0); `inputPagesUrl` (raw file → blob URL, other → directory, every fixture record's `url` starts with it);
  `indexStaleWarning` at 47:59:59 → null and at 48:00:00 → the exact INDEX text; `inputStaleWarning`
  for BEHIND (exact text), UNKNOWN at 13 vs 14 days (exact text), and `sha === head_sha` at 400
  days → null; `inputNote` with and without a commit; `docsFreshness` de-duplicates inputs by url
  and keeps the index warning first.
- `test/docs-index/commits.test.ts`, with a synthetic `FetchFn` serving JSON by URL:
  `branchCommit` maps a branch response; `pagesCommit` takes the first deployment whose newest
  status is `success` (newest `in_progress`, next `failure`, third `success` → third); it calls
  `branches/<deployment.ref>`; null and no branch request when none qualify; it requests
  `per_page=10` and `per_page=1`.

Updated:

- `test/upstreams/github.test.ts`: URLs, headers and schema failures for `getBranch`,
  `listDeployments` and `listDeploymentStatuses` (existing style).
- `test/docs-index/fixtures.test.ts`: the query-string segment mapping, the round trip through
  `recordingFetch` → `fixtureDocsFetch`, and the unsafe-segment check on the new segment.
- `test/docs-index/config.test.ts`: `site_repo` required; `github_owner: other` rejected.
- `test/docs-index/build.test.ts`: the snapshot (`-u`, reviewed) with `commit` objects; the site and
  repo commit assertions from the acceptance criteria; a missing `branches/main` fixture fails the
  build; `env.GITHUB_TOKEN` reaches only `api.github.com` requests.
- `test/docs-index/load.test.ts`: a format-1 store is rejected.
- `test/support/docs.ts` (`syntheticDocsIndex`): the input gains `commit: null`, plus an optional
  parameter for its `commit` so search and read tests can make a behind input.
- `test/core/docs/search.test.ts` and `read.test.ts`: the new fields, the summary formats, and the
  stale cases with a controlled `deps.now`. Tests that assert exact summaries are updated to the
  new text.
- `test/core/about.test.ts`: `buildAbout(modules, now)` passes `now` to `datasets` and passes
  `age_days`, `possibly_stale` and input `commit` through.
- `test/transports/docs.test.ts`: the REST and MCP about responses are equal and carry the commits.
  It also gets an MCP `docs_search` structuredContent check for `freshness`.

Commands, in order: `npm run docs:fixtures`, `npm run typecheck`, `npm test`, `npm run build`,
`npm run eval:docs`. Run the eval once on `main` (numbers above) and once on the branch.

## Risks

- **Raw files are fetched by ref, after the branch lookup.** A push in that window, or
  raw.githubusercontent.com's CDN cache (verified `x-cache: HIT`; a few minutes), can make a repo
  file's content differ from `commit.sha`. The next daily rebuild corrects it. Fetching raw at the
  sha would close the gap, but it would change every repo input URL and fixture path. That is out
  of scope.
- **Pages deployments may not reflect what is served.** If someone republishes the site another way
  (a `gh-pages` branch, a different host), `pagesCommit` reports an old deployment and the
  site looks behind. Today `build_type` is `workflow`, which is the only way it publishes.
- **The workflow token across repos.** `github.token` belongs to seandavi/bioc-mcp. Reading another
  public repo's branches and deployments with it should work at the authenticated limit, but
  that has not been verified, because the Deploy workflow runs only from main. If it gets a 401 or
  403, the first deploy after merge fails at `docs:build` with the adapter's message. The fix is
  then to drop the `env` line, which leaves about 14 anonymous calls per run.
- **Stale warnings for commits that do not touch the docs.** `docs.yml` deploys on every push to
  `main`, so being behind is short-lived unless a deploy fails, and the wording is "may lag", not
  "is stale". The daily rebuild and the `docs-updated` dispatch clear it.
- **Mixed fixtures.** The recorded `branches/main` shas are from the implementation date, while two
  content fixtures already differ from live (Spec #61). No test ties content to a sha. A later
  full `npm run docs:record` brings them back in line.
- **Fewer hits at `limit` 10.** Each hit grows by about 130 bytes (data plus summary), and the
  freshness block adds about 100. Near 8 KB, one or two more trailing hits can be dropped (nine
  questions drop one today). Five hits are about 5 KB, so recall@5 cannot change. MRR@10 can drop
  only when an answer ranks 9th or 10th. The PR reports it.
- **Format bump.** An index built by older code cannot be loaded by newer code, or the other way
  round. The artifact is always rebuilt with the code (`pretest`, `prebuild`, Deploy), so this
  shows up only with a stale local `generated/`. `npm run docs:fixtures` fixes it.
