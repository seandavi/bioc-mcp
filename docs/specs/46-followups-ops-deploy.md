# Spec #46: follow-ups for `ops_activity` and deploy (from the #9 and #11 reviews)

Issue: [seandavi/bioc-mcp#46](https://github.com/seandavi/bioc-mcp/issues/46). Source findings:
[#32](https://github.com/seandavi/bioc-mcp/issues/32) (the #9 review; every item except
code-r0-3) and [#26](https://github.com/seandavi/bioc-mcp/issues/26) (the #11 review; every
item). Builds on [spec #9](9-ops-activity.md) and [spec #11](11-deploy.md). Project design:
[proposal-mcp.qmd](https://github.com/seandavi/bioc-infrastructure/blob/spec/mcp/proposal-mcp.qmd).
Conventions: [AGENTS.md](../../AGENTS.md).

The files in scope: `src/core/ops/*`, `src/upstreams/github.ts` (all except the error *wording*
code-r0-3, which moved to [#43](https://github.com/seandavi/bioc-mcp/issues/43)),
`src/rate-limit.ts`, `docs/deploy.md`, their tests and test support, and the spec and README text
those findings name.

What the following notes record was checked on 2026-10-22/23 with the installed packages (zod
4.6.7, vitest 5.0.5, Node 26.8.1 locally; CI uses 24) and live requests. **Verified** marks what
was observed. **Inferred** marks what was not.

- **Verified (Cache API on workers.dev):** two `GET https://bioc-mcp.seandavi.workers.dev/api/v1/ops/activity?kind=failures`
  requests 3 s apart, at 2026-10-23T02:25:53Z, both returned `sources[0].as_of` =
  `2026-10-23T02:25:53.380Z`. The production Worker has no in-memory layer
  (`createCloudflareCache(caches.default)` in `src/index.ts`), so the second answer came from
  `caches.default`. The Cache API works on the deployed workers.dev hostname.
- **Verified (Cloudflare docs, `fundamentals/api/reference/template`):** the "Edit Cloudflare
  Workers" template grants Workers Routes Write (zone), Workers Scripts Write, Workers KV Storage
  Write, Workers Tail Read, Workers R2 Storage Write, Account Settings Read, User Details Read and
  User Memberships Read. It does **not** include Cloudflare Pages (the reviewer guessed it did) or
  Account Analytics Read.
- **Verified (Cloudflare API reference, "Accepted Permissions"):** every endpoint `wrangler deploy`
  needs for this Worker accepts **Workers Scripts Write**: script upload
  (`workers/scripts/methods/update`), versions create, deployments create, the per-script
  workers.dev subdomain (`scripts/subdomain/methods/create`), the account subdomain read
  (`subdomains/methods/get`) and the secrets list (`scripts/secrets/methods/list`, used by
  `secrets.required`). **Inferred:** the rate-limit and Analytics Engine bindings ride on the
  script upload and need nothing more. A Deploy run after the token swap confirms it (Needs a human).
- **Verified (Cloudflare docs, `analytics/analytics-engine/sql-api`):** the SQL API needs a token
  with *Account | Account Analytics | Read*.
- **Verified:** Node ≥ 22 `readdirSync(dir, { recursive: true, withFileTypes: true })` returns
  `Dirent`s with `parentPath`, `name` and `isFile()`.
- **Verified (measured):** on the recorded fixtures today, envelope bytes are: summary 5,183
  (all repos), issues 5,370, prs 3,977, workflows 2,927, failures 807. A synthetic `kind=prs`
  across all repos with 10 bioc-mcp PRs (200-character titles, all `CONFLICTING`) newest is
  5,242 bytes with no failing checks. That is the base for the check-name budget in
  [security-r0-2](#security-r0-2-bounded-failing-check-names).

## Goal

Close every in-scope checkbox on #32 and #26 in one PR. Each item ends **fixed**, **moot**
(already resolved) or **declined** (with a reason). The PR body repeats this table so both source
issues can be closed when it merges:

| Source | Id | Outcome | What changes |
|---|---|---|---|
| #32 | code-r0-3 (+ ux-r0-7) | **out of scope** | Moved to #43 (upstream bundle). Not touched here |
| #32 | code-r0-4 | fixed | `listWorkflowRuns` takes `perPage`; `github.ts` imports nothing from core but types; a test enforces it for every adapter |
| #32 | code-r0-5 | fixed | `/mcp` test builds with `pkgModule` and `opsModule` and asserts the exact tool set |
| #32 | code-r0-6 | fixed (part moot) | Delete `MS_PER_DAY` in activity.ts and `WEBSITE_SHA` in github.test.ts. `OPS_OWNER` is **moot**: `failureItems` reads it since security-r0-1 |
| #32 | code-r0-7 | fixed | `githubRoutes` skips only directories and throws on any unmapped file |
| #32 | code-r0-8 | fixed | Token test: REST/MCP errors also for timeout, and both REST/MCP tests check the console spy |
| #32 | code-r0-9 | fixed | `getRepo` and `listWorkflows` run concurrently |
| #32 | code-r0-10 | fixed | `FAILURE_ISSUE_REPO = 'bioc-edge' satisfies OpsRepo` |
| #32 | ux-r0-1 | fixed | Description says `workflows` lists all with repo, only fail/warn without |
| #32 | ux-r0-2 | fixed | With repo and a cut list, the issues/prs summary points to the GitHub list; README says "lists are capped or paginate" |
| #32 | ux-r0-3 | fixed | HTTP 401 with a token → "GitHub rejected this server's GITHUB_TOKEN" |
| #32 | ux-r0-4 | fixed (part moot) | The stale "only tool is meta_ping" sentence is **moot** (gone since #40's tool table). Added: a `.dev.vars` `GITHUB_TOKEN` line and an `ops/activity` example under "Run it locally" |
| #32 | ux-r0-5 | fixed | Workflows summary says when the list is cut; `omitted` described in workflows and failures |
| #32 | ux-r0-6 | fixed | `failure_issues` description matches what it counts |
| #32 | ux-r0-8 | fixed | Agent-facing text no longer says "bioc-health" |
| #32 | security-r0-2 (+ security-r1-1) | fixed | `failing_checks` capped (3 names × 40 characters), new `failing_check_count`, `reason` counts instead of naming; the 8 KB section and parity table corrected |
| #32 | security-r0-3 | fixed (docs; code part moot) | #11 added the per-address limiter; the Cache API is verified on workers.dev (above). Recorded in spec 9 and spec 11 Risks |
| #32 | code-r1-1 | fixed | Spec 9's "Verified" note says the author check is ours, not crossref.py's |
| #32 | code-r1-2 | fixed | The flood test runs `summary` with `{}` and `{ repo: 'bioc-edge' }` |
| #26 | code-r0-1 (+ security-r0-3) | fixed | Usage query uses `$CLOUDFLARE_ANALYTICS_TOKEN`, a separate Account Analytics: Read token kept in GSM only |
| #26 | code-r0-2 | fixed | "pull requests and pushes to `main`" |
| #26 | code-r0-3 | fixed | §4: token from GSM, account ID from `npx wrangler whoami` |
| #26 | security-r0-1 | fixed | Rate-limit key: an IPv6 address counts by its /64 |
| #26 | security-r0-2 | fixed (docs) | §2 lists the minimal deploy-token permissions instead of the template |

## Non-goals

- code-r0-3 / ux-r0-7 (error wording in `githubJson`, `errorsSentence` periods, sub-path 404
  wording, `fetchUpstream`'s non-5xx message). Those belong to #43. The one change here inside
  `githubJson` is the new 401 branch (ux-r0-3), which #43 must keep.
- No new capability, module, upstream or recorded fixture. `ops_activity` keeps its MCP tool name
  and REST route. Its output changes in one way: `prs` items gain `failing_check_count`, and
  `failing_checks`/`reason` are bounded. The REST API is unstable until v1 (AGENTS.md).
- No pagination for `ops_activity`. Lists stay capped (spec 9 non-goal).
- No Cloudflare dashboard or GitHub settings changes, and no secret creation, rotation or
  deletion. The PR edits the runbook; a person rotates the token afterwards (Needs a human).
- `OPS_OWNER` is not threaded into `GITHUB_BASE_URL`. The adapter must not import core values
  (code-r0-4), and `'seandavi'` in the base URL is part of its SSRF boundary.
- PR titles stay at 80 characters. Only check names are newly bounded (see Risks for non-ASCII).

## Design

### Files

```
src/core/ops/config.ts         FAILURE_ISSUE_REPO `satisfies`; + FAILING_CHECK_LIMIT, CHECK_NAME_LIMIT
src/core/ops/rules.ts          prStatus(failingCheckCount, …); + truncateText(); truncateTitle uses it
src/core/ops/activity.ts       MS_PER_DAY removed; readWorkflows concurrent; listWorkflowRuns(…, perPage);
                               PR items bounded + failing_check_count; summary wording (ux-r0-2, ux-r0-5);
                               schema descriptions (ux-r0-5, ux-r0-6, ux-r0-8); tool description (ux-r0-1, ux-r0-8)
src/upstreams/github.ts        no THRESHOLDS import; listWorkflowRuns(deps, repo, file, branch, perPage); 401 branch
src/rate-limit.ts              + rateLimitKey(); middleware uses it
test/support/github-routes.ts  Dirent walk; githubRoutes(dir?) ; unknown file throws
test/support/app.ts            makeTestApp option `fetch`
test/upstreams/github.test.ts  WEBSITE_SHA removed; perPage; 401; githubRoutes stray file
test/upstreams/imports.test.ts NEW  adapters import core only as types
test/core/ops/rules.test.ts    prStatus by count; truncateText
test/core/ops/activity.test.ts updated strings; bounded checks; concurrency; flood with {}; omitted sentence; type test
test/core/ops/token.test.ts    401; REST/MCP timeout; console spy in REST/MCP tests
test/transports/ops.test.ts    /mcp exact tool set; no "bioc-health" in tools/list; description clause
test/rate-limit.test.ts        rateLimitKey table; one /64 shares a key through the middleware
docs/deploy.md                 §1, §2, §4, §7, §8
docs/specs/9-ops-activity.md   brought in line with every change above (list below)
docs/specs/11-deploy.md        brought in line with #26 (list below)
README.md                      "lists are capped or paginate"; GITHUB_TOKEN/.dev.vars line; IPv6 /64 in the rate-limit line
```

Import zod as `import * as z from 'zod'`, as elsewhere.

### code-r0-4: the adapter takes the page size (`src/upstreams/github.ts`)

Remove `import { THRESHOLDS } from '../core/ops/config';`. New signature:

```ts
export async function listWorkflowRuns(
  deps: Deps,
  repo: string,
  file: string,
  branch: string,
  perPage: number,
): Promise<Fetched<GithubWorkflowRun[]>> {
  const path =
    `${pathSegment(repo)}/actions/workflows/${pathSegment(file)}/runs` +
    `?branch=${encodeURIComponent(branch)}&per_page=${perPage}&exclude_pull_requests=true`;
  …unchanged
}
```

`readWorkflows` in activity.ts calls `listWorkflowRuns(deps, repo, file, defaultBranch, THRESHOLDS.runsPerWorkflow)`.
URLs are byte-identical to today (`per_page=20`), so fixtures and routes do not change.

`test/upstreams/imports.test.ts` (new) guards the seam for every adapter: read each
`src/upstreams/*.ts` with `readFileSync`, find every statement matching
`/^(?:import|export)\s[^;]*?from\s+'\.\.\/core\/[^']*'/gm` (`[^;]` spans wrapped lines), and assert
each starts with `import type ` or `export type ` (#79). Today
`bioconductor.ts`, `http.ts`, `r-universe.ts` and `registry.ts` already comply. Only `github.ts`
fails, and only until this fix.

### code-r0-5: `/mcp` lists the meta, pkg and ops tools (`test/transports/ops.test.ts`)

In the test "/mcp/ops lists exactly ops_activity; /mcp also lists the other tools", build the
`/mcp` app with `makeTestApp({ routes: githubRoutes(), extraModules: [pkgModule, opsModule], now })`
(import `pkgModule` from `../../src/core/pkg` and `metaModule` from `../../src/core/meta`). Assert:

```ts
const expected = [metaModule, pkgModule, opsModule].flatMap((m) => m.capabilities.map((c) => c.name));
expect(names.filter((name) => !name.startsWith('example_')).sort()).toEqual([...expected].sort());
```

### code-r0-6: dead code

- `src/core/ops/activity.ts`: delete `const MS_PER_DAY = 86_400_000;` (unused; rules.ts has its own).
- `test/upstreams/github.test.ts`: delete `const WEBSITE_SHA = …` and `void WEBSITE_SHA;`.
- `OPS_OWNER` stays: `failureItems` and (new, ux-r0-2) the summary URLs read it.

### code-r0-7: fixture walk fails loudly (`test/support/github-routes.ts`)

```ts
/** Every recorded GitHub response under `dir` (default test/fixtures/github), keyed by URL. A fresh object each call. */
export function githubRoutes(dir: string = GITHUB_DIR): Record<string, FixtureRoute>;
```

For each repo directory under `dir`, read `repo.json`, then walk
`readdirSync(repoDir, { recursive: true, withFileTypes: true })`. Skip entries where
`!entry.isFile()` (directories). For each file, `path = relative(repoDir, join(entry.parentPath, entry.name)).split(sep).join('/')`,
and `suffixFor(path, defaultBranch)`. `undefined` → `throw new Error(\`Unknown GitHub fixture: ${repo.name}/${path}\`)`.
The route's `file` is `relative(FIXTURES_DIR, join(entry.parentPath, entry.name))` with `/`
separators, where `FIXTURES_DIR` is `test/fixtures` (one level above `GITHUB_DIR`). So the default
`dir` keeps today's `github/<repo>/<path>` values. The `.endsWith('.json')` skip is removed.
Top-level files in `dir` (`RECORDED_AT`) are not repo directories and stay ignored.

Test (in `test/upstreams/github.test.ts`, `describe('githubRoutes')`): make a temp dir with
`mkdtempSync(join(tmpdir(), 'gh-routes-'))` containing `bioc-x/repo.json` (`{"default_branch":"main"}`)
and `bioc-x/notes.txt`, then expect `githubRoutes(dir)` to throw `Unknown GitHub fixture: bioc-x/notes.txt`.
Remove the dir in `finally` (`rmSync(dir, { recursive: true, force: true })`). Also assert that
`Object.keys(githubRoutes()).length` equals the number of files under `test/fixtures/github/*/`
(all are mapped).

### code-r0-8: token test completeness (`test/core/ops/token.test.ts`, `test/support/app.ts`)

`makeTestApp` gains `fetch?: FetchFn & { calls: string[] }`. When it is given, it replaces
`fixtureFetch(options.routes ?? …)`, and it is what the result's `fetch` returns. The option is
needed because a `'timeout'` route waits for `fetchUpstream`'s 10 s abort.

In `'REST and MCP errors for a %s do not contain the token'`:

- The cases become `[401, 403, 404, 500, 'timeout', 'network-error']`.
- For `'timeout'`, pass `fetch: Object.assign(() => Promise.reject(new DOMException('timed out', 'TimeoutError')), { calls: [] as string[] })`
  instead of routes. REST is still 502 (`httpStatusFor('upstream_timeout')` is 502).
- End both this test and `'REST and MCP %s bodies do not contain the token'` with
  `expect(consoleCalls.map((args) => JSON.stringify(args)).join('')).not.toContain(SENTINEL);`.

`'a %s on every repo leaks nothing'` (invoke level) gains `401` in its list.

### code-r0-9: concurrent reads (`readWorkflows` in `src/core/ops/activity.ts`)

```ts
/** (getRepo ∥ listWorkflows) → the newest default-branch runs of each active workflow. */
const [repoRead, workflowsRead] = await Promise.all([getRepo(deps, repo), listWorkflows(deps, repo)]);
track(repoRead.response);
track(workflowsRead.response);
const defaultBranch = repoRead.data.default_branch;
```

The rest of the function is unchanged. If either call throws, `Promise.all` rejects with that
`CapabilityError` and the repo's outcome is `ok: false`, as before.

Test (activity.test.ts, `describe('workflows')`, `'getRepo and listWorkflows are requested together'`):
wrap `deps.fetch`. When the workflows URL (`githubUrl('bioc-website', '/actions/workflows?per_page=100')`)
is requested, resolve a `workflowsSeen` promise. When the repo URL (`githubUrl('bioc-website')`)
is requested, `await Promise.race([workflowsSeen.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 100))])`,
store the result in `workflowsBeforeRepo`, then delegate. Run `{ kind: 'workflows', repo: 'bioc-website' }`.
Expect `ok` and `workflowsBeforeRepo === true`. With sequential code it would be `false` after
100 ms.

### code-r0-10: literal type (`src/core/ops/config.ts`)

```ts
/** Where bioc-notify@ (bioc-edge/notify-failure.sh) files "<unit> is failing" issues. */
export const FAILURE_ISSUE_REPO = 'bioc-edge' satisfies OpsRepo;
```

Type test in activity.test.ts (checked by `npm run typecheck`, which includes `test/`):
`expectTypeOf<Of<'failures'>['repo']>().toEqualTypeOf<'bioc-edge'>();` (`expectTypeOf` from `vitest`).

### ux-r0-1 and ux-r0-8: the tool description and status description

`StatusSchema`:

```ts
const StatusSchema = z
  .enum(['ok', 'info', 'warn', 'fail'])
  .describe(
    "Classification by the bioc-infrastructure health report's rules: 'fail' and 'warn' need attention, 'info' is worth knowing",
  );
```

`opsActivity.description`, exactly:

```ts
description:
  'Open issues and pull requests, default-branch GitHub Actions results, and open "<unit> is failing" ' +
  `issues across the seandavi/bioc-* infrastructure repos (${OPS_REPOS.join(', ')}). ` +
  "kind 'summary' (default) gives counts per repo and the workflows needing attention; 'issues' lists open " +
  "issues newest first, with staleness (untouched over 30 days); 'prs' lists open PRs with failing checks, " +
  "merge conflicts and staleness (over 14 days); 'workflows' gives each workflow's latest conclusion, failure " +
  'streak and last success on the default branch (every workflow when repo is given; without repo, only those ' +
  "that fail or warn); 'failures' lists the '<unit> is failing' issues bioc-notify@ files in bioc-edge, which " +
  'nothing closes on recovery. repo narrows to one repo. Statuses (ok, info, warn, fail) follow the rules of ' +
  "the bioc-infrastructure health report. Public GitHub data, cached 2 minutes. For a package's build or " +
  'propagation state use pkg_status. Does not report host, service or traffic health.',
```

Code comments that cite bioc-health (rules.ts, config.ts) stay: they are for maintainers, not the
model.

### ux-r0-2: point to the full list (`collectIssues`, `collectPrs`)

Issues sentence, when `omitted > 0`:

```ts
`; ${omitted} more are not${ctx.repo ? ` (see https://github.com/${OPS_OWNER}/${ctx.repo}/issues)` : ' (pass repo to narrow)'}`
```

PRs sentence, when `omitted > 0`:

```ts
` ${omitted} older PRs were not checked${ctx.repo ? ` (see https://github.com/${OPS_OWNER}/${ctx.repo}/pulls)` : '; pass repo to narrow'}.`
```

So `repo=bioc-infrastructure` ends `…; 99 more are not (see https://github.com/seandavi/bioc-infrastructure/issues).`
(the exact count is whatever the fixture gives), and the 12-PR bioc-mcp case ends
`2 older PRs were not checked (see https://github.com/seandavi/bioc-mcp/pulls).`

README "Principles": `lists paginate` → `lists are capped or paginate`.

README "REST quickstart", the rate-limit sentence (security-r0-1) becomes: "Rate limit: 120
requests per minute per client address (an IPv6 /64 counts as one address; approximate, per
Cloudflare location)." The rest of that paragraph is unchanged.

### ux-r0-3: 401 means the token is bad (`githubJson` in `src/upstreams/github.ts`)

Add, before the 403/429 branch:

```ts
if (status === 401 && deps.env.GITHUB_TOKEN?.trim()) {
  throw new CapabilityError(
    'upstream_error',
    "GitHub rejected this server's GITHUB_TOKEN (HTTP 401); the operator must replace the secret. Try again later.",
    error.details,
  );
}
```

Without a token a 401 is not about our secret, so it propagates unchanged (today's generic
message). The message names the variable, never its value. `error.details` is
`{ upstream, url, status }` from `fetchUpstream` and holds no header.

Tests (`test/upstreams/github.test.ts`, `describe('errors')`): with `{ GITHUB_TOKEN: 'sentinel' }`
and route `{ status: 401 }`, the error is `upstream_error`, its message is exactly the string above,
`details.status` is 401, and neither message nor details contains `sentinel`. Without a token,
401 gives `upstream_error` whose message does not contain `GITHUB_TOKEN`. Token tests: see code-r0-8.

### ux-r0-4: running ops locally (README "Run it locally")

The "Today the only tool is `meta_ping`" sentence no longer exists (moot). Append to the "Run it
locally" section, after the `curl …/meta/ping` sentence:

```markdown
`ops_activity` reads the GitHub API. Without a token GitHub allows 60 requests an hour, and one
all-repo summary uses about 49. Put `GITHUB_TOKEN=<a GitHub token with no repository permissions>`
in `.dev.vars` (gitignored), restart `npm run dev`, and try
`curl 'http://127.0.0.1:8787/api/v1/ops/activity?kind=workflows&repo=bioc-website'`.
```

### ux-r0-5: say when the workflow list is cut

In `collectWorkflows`, with `omitted = eligible.length - workflows.length`, the summary becomes:

```ts
joinSentences([
  totalsSentence,             // unchanged
  problemsSentence(all),      // unchanged
  omitted > 0 ? `Only the first ${WORKFLOW_ITEM_LIMIT} are listed; ${omitted} more are not.` : undefined,
  errorsSentence(outcomes),
])
```

Schema descriptions:

```ts
// WorkflowsDataSchema
omitted: z.number().int().describe('Workflows eligible for the list but not listed because of the cap'),
// FailuresDataSchema
omitted: z.number().int().describe("Units with an open '<unit> is failing' issue not listed because of the cap"),
```

Test: the existing "more than 12 workflows needing attention" case also asserts that
`summary` contains `Only the first 12 are listed; 3 more are not.`.

### ux-r0-6: `failure_issues` description

```ts
failure_issues: z
  .number()
  .int()
  .nullable()
  .describe("Units with an open '<unit> is failing' issue; only for bioc-edge (null for other repos, or when bioc-edge could not be read)"),
```

### security-r0-2: bounded failing check names

On a fork PR, GitHub runs the PR's copy of the workflow, so check-run names are chosen by the
contributor. The reviewer's proposed cap (5 names of 80 characters, still listed in `reason`) is
bounded, but it does not fit the 8 KB limit: 10 hostile PRs add about 850 bytes each to their
items and about 440 each to 5 summary lines, about 10.7 KB on top of the 5,242-byte measured base.
The design below fits. **Estimated** from the same base: each hostile PR adds about 178 bytes
(3 names of 42 UTF-8 bytes in JSON, the count field, and `100 failing checks; ` in `reason`), and
each summary line adds 20, so about 7.1 KB in all for 10 hostile PRs with ASCII names and titles.
The size tests below measure it.

`src/core/ops/config.ts` (the limits and `truncateText` below are superseded by #79: they count
UTF-8 bytes of JSON text on whole code points, see spec 9):

```ts
export const FAILING_CHECK_LIMIT = 3; // names kept per PR in failing_checks
export const CHECK_NAME_LIMIT = 40; // characters per kept name
```

`src/core/ops/rules.ts`:

```ts
/** At most `limit` UTF-16 code units: the first limit − 1 plus '…' when longer. */
export function truncateText(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** At most 80 UTF-16 code units: the first 79 plus '…' when longer. */
export function truncateTitle(title: string): string {
  return truncateText(title, TITLE_LIMIT);
}

/**
 * bioc-health pr_status, except that the reason counts failing checks instead of naming them:
 * check names come from the PR's own workflow file, so they are contributor-controlled text.
 * Only 'ok' | 'info' | 'warn' occur.
 */
export function prStatus(
  failingCheckCount: number,
  mergeable: Mergeable,
  updatedAgeDays: number,
  isDraft: boolean,
): { status: HealthStatus; reason: string } {
  const problems: string[] = [];
  if (failingCheckCount > 0) problems.push(`${failingCheckCount} failing check${failingCheckCount === 1 ? '' : 's'}`);
  if (mergeable === 'CONFLICTING') problems.push('merge conflicts');
  …rest unchanged
}
```

`prChecksFailing` is unchanged. It returns every name, which keeps parity with bioc-health.

`PrItemSchema` (activity.ts):

```ts
failing_checks: z
  .array(z.string())
  .describe('Up to 3 failing check runs and commit statuses on the head commit (check runs first), each at most 40 characters'),
failing_check_count: z.number().int().describe('All failing check runs and commit statuses on the head commit'),
status: StatusSchema,
reason: z.string().describe("e.g. '2 failing checks; merge conflicts', 'no activity for 67 days', 'ok'"),
```

`collectPrs`, per kept PR:

```ts
const failing = prChecksFailing(checks.data.check_runs, status.data.statuses);
…
failing_checks: failing.slice(0, FAILING_CHECK_LIMIT).map((name) => truncateText(name, CHECK_NAME_LIMIT)),
failing_check_count: failing.length,
...prStatus(failing.length, mergeable, updatedAge, pull.draft),
```

The "Need attention" summary sentence is unchanged in form. It now reads, for example,
`bioc-mcp#12 (2 failing checks; merge conflicts)`.

Tests:

- rules.test.ts: `prStatus(0, 'CONFLICTING', 1, false)` → `{ warn, 'merge conflicts' }`;
  `prStatus(1, 'MERGEABLE', 1, false)` → `{ warn, '1 failing check' }`;
  `prStatus(2, 'CONFLICTING', 1, false).reason` → `'2 failing checks; merge conflicts'`; the
  info/ok/UNKNOWN cases pass `0` instead of `[]`. `truncateText('abcdef', 4)` → `'abc…'`,
  `truncateText('abcd', 4)` → `'abcd'`. The `truncateTitle` test is unchanged.
- activity.test.ts `'failing checks list the check run first, then the status context'`: expect
  `failing_checks` `['build-deploy', 'ci/legacy']`, `failing_check_count` 2, reason
  `'2 failing checks; merge conflicts'`.
- activity.test.ts, new `'a PR with 100 long failing checks stays bounded'`: one bioc-mcp PR
  (synthetic `pulls`, detail `mergeable: false`, check-runs page with 100 runs named
  `` `${i}-${'c'.repeat(200)}` `` with `conclusion: 'failure'`, empty statuses). For `{ kind: 'prs' }` and
  `{ kind: 'prs', repo: 'bioc-mcp' }`: `envelopeBytes < MAX_RESULT_BYTES`; the item has 3
  `failing_checks`, each `length <= 40` and ending `…`; `failing_check_count` 100; reason
  `'100 failing checks; merge conflicts'`; `summary` does not contain `'c'.repeat(40)`.
- activity.test.ts, new `'ten hostile PRs still fit'`: 10 bioc-mcp PRs created from 2026-10-22T12:00Z
  (newer than every recorded PR; the newest is bioc-infrastructure#122 at 11:51), titles of 200 `T`s, `mergeable: false`, each with the same
  100-run page. `{ kind: 'prs' }` and `{ kind: 'prs', repo: 'bioc-mcp' }` are both under
  `MAX_RESULT_BYTES`. Expected about 7.1 KB. If the implementation measures 8,192 or more, stop
  and report; do not loosen the test.

### security-r0-3: shared token budget

No code change. Since #11, `/mcp*` and `/api/*` are rate-limited per address (now per /64 for
IPv6, security-r0-1 below). The Cache API is verified to work on the deployed hostname (see the
first note). Record both facts in spec 9's Risks "Rate limit" bullet and in spec 11's Risks
"Cache API" bullet (texts below).

### code-r1-1 and code-r1-2

- Spec 9, the "Verified" note under the parity table, second sentence becomes: "crossref.py uses
  the title as the only marker; this server also requires `user.login === OPS_OWNER` (see the
  row above)."
- activity.test.ts `'60 issues with maximum-length units still fit…'`: for `failures` run `{}`.
  For `summary` run both `{}` and `{ repo: 'bioc-edge' }`. Every run asserts
  `envelopeBytes(envelope) < MAX_RESULT_BYTES`, the `60 open "<unit> is failing" issues in bioc-edge`
  text and `and 45 more`.

### security-r0-1: IPv6 by /64 (`src/rate-limit.ts`)

```ts
const HEXTET = /^[0-9a-f]{1,4}$/;

/**
 * The limiter key for a client address. An IPv6 client usually holds a whole /64, so an IPv6
 * address counts by its /64 prefix ("2001:db8:1:2::/64"); an IPv4-embedded IPv6 address
 * ("::ffff:203.0.113.9") by its IPv4 part; anything else, including text that does not parse,
 * as is. No address: 'unknown'.
 */
export function rateLimitKey(address: string | undefined): string {
  if (!address) return 'unknown';
  if (!address.includes(':')) return address;
  if (address.includes('.')) return address.slice(address.lastIndexOf(':') + 1);
  const halves = address.toLowerCase().split('::');
  if (halves.length > 2) return address;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return address;
  const groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  if (!groups.every((group) => HEXTET.test(group))) return address;
  return `${groups
    .slice(0, 4)
    .map((group) => parseInt(group, 16).toString(16))
    .join(':')}::/64`;
}
```

`rateLimitMiddleware` step 1 becomes `const key = rateLimitKey(c.req.header('cf-connecting-ip'));`,
and its doc comment says "One limiter key per client address (an IPv6 /64 counts as one;
rateLimitKey), else 'unknown'. Fails open." The key never appears in a response, log or event,
as before.

Tests (`test/rate-limit.test.ts`):

- `test.each` over `rateLimitKey`:

  | Input | Key |
  |---|---|
  | `undefined` | `unknown` |
  | `'203.0.113.9'` | `203.0.113.9` |
  | `'2001:db8:1:2::1'` | `2001:db8:1:2::/64` |
  | `'2001:DB8:0001:0002:ffff:ffff:ffff:ffff'` | `2001:db8:1:2::/64` |
  | `'2001:db8::'` | `2001:db8:0:0::/64` |
  | `'::1'` | `0:0:0:0::/64` |
  | `'::'` | `0:0:0:0::/64` |
  | `'::ffff:203.0.113.9'` | `203.0.113.9` |
  | `'fe80::1%eth0'` | `fe80::1%eth0` |
  | `'1::2::3'` | `1::2::3` |
  | `'1:2:3:4:5:6:7:8:9'` | `1:2:3:4:5:6:7:8:9` |
  | `'1:2:3:4:5:6:7::8'` | `1:2:3:4:5:6:7::8` |
  | `'2001:db8:1:2:3:4:5:g'` | `2001:db8:1:2:3:4:5:g` |

- Through the middleware: requests with `cf-connecting-ip` `2001:db8:1:2::1` and
  `2001:db8:1:2:ffff:ffff:ffff:ffff` call the limiter with the same key `2001:db8:1:2::/64`;
  `2001:db8:1:3::1` gets `2001:db8:1:3::/64`. The existing IPv4 and `'unknown'` tests stay.

### `docs/deploy.md`

- **§1** `ci.yml` row: "pull requests and pushes to `main`".
- **§2** Secrets table. The deploy-token row's "What" becomes: "Cloudflare **Account** API token
  for the one account that owns `seandavi.workers.dev`, with exactly **Account › Workers Scripts:
  Edit** and **Account › Account Settings: Read**. Do not start from the "Edit Cloudflare Workers"
  template, or remove everything else it adds: Workers KV Storage, Workers R2 Storage, Workers
  Tail, and the zone-level Workers Routes (no routes are used), plus User Details and Memberships
  if offered." Then one sentence after the table: "Every endpoint `wrangler deploy` uses here
  (script upload, versions, deployments, the workers.dev subdomain, the required-secrets check)
  accepts Workers Scripts: Edit; Account Settings: Read is kept from the template." Add a third row:

  | GSM secret | What | Copy lives in |
  |---|---|---|
  | `cdsci-bioc-mcp-analytics-token` | Cloudflare Account API token with only **Account › Account Analytics: Read**, for the usage query (§8). The deploy token does not have this permission and must not be given it | nowhere: exported in a local shell when querying; never in GitHub or the Worker |

- **§4** First deploy: "with `CLOUDFLARE_API_TOKEN` exported from GSM
  (`cdsci-bioc-mcp-cloudflare-deploy-token`) and `CLOUDFLARE_ACCOUNT_ID` (from
  `npx wrangler whoami`):".
- **§7** first sentence: "120 requests per 60 s per client address per Cloudflare location,
  approximate (the Workers rate-limit binding), on `/mcp*` and `/api/*`. An IPv6 address counts by
  its /64 prefix, since one client usually holds the whole /64."
- **§8** Replace "The query token needs Account Analytics: Read." with: "The query uses its own
  token, `cdsci-bioc-mcp-analytics-token` (§2), not the deploy token." In the command block, add
  before `curl`:

  ```sh
  export CLOUDFLARE_ANALYTICS_TOKEN=$(gcloud secrets versions access latest --secret=cdsci-bioc-mcp-analytics-token --project=cdsci-infra)
  ```

  and change the header to `-H "Authorization: Bearer $CLOUDFLARE_ANALYTICS_TOKEN"`.

### `docs/specs/11-deploy.md`

Bring the spec in line, using the same wording as the runbook:

- The `docs/deploy.md` item 1 (`ci.yml` "PRs and pushes to `main`"), item 2 (secrets table and the
  analytics-token row), item 4 (token from GSM, account ID from `npx wrangler whoami`), item 7
  (/64) and item 8 (`$CLOUDFLARE_ANALYTICS_TOKEN` and the export line).
- The decisions-table "Rate-limit key" row: "`rateLimitKey(cf-connecting-ip)`: the address, an
  IPv6 address by its /64, else `'unknown'`; …".
- The `src/rate-limit.ts` section: add the `rateLimitKey` signature, and change Behaviour step 1.
- Acceptance criterion "The limiter key is the `cf-connecting-ip` value…" gains: "an IPv6 address
  by its /64".
- Risks, the "Cache API on workers.dev is inferred from docs" bullet becomes: "**Cache API on
  workers.dev: verified 2026-10-23.** Two identical `ops_activity?kind=failures` calls 3 s apart
  returned the same `as_of`; production has no in-memory layer, so `caches.default` served the
  second. The cache is per data centre, so many locations still multiply upstream load."
- Risks, the "Rate limits are approximate" bullet gains: "IPv6 clients are keyed by /64 (#26
  security-r0-1), so rotating addresses inside one /64 does not reset the budget; a client with
  many /64s or many IPv4 addresses still can."
- Risks, the "`npm ci` runs in the job that holds the deploy token" bullet: replace "(Workers edit
  on one account)" with "(Workers Scripts: Edit and Account Settings: Read on one account; no KV,
  R2, Pages or zone permissions)".

### `docs/specs/9-ops-activity.md`

Bring the spec in line with the code:

1. `config.ts` snippet: `FAILURE_ISSUE_REPO = 'bioc-edge' satisfies OpsRepo`, plus
   `FAILING_CHECK_LIMIT` and `CHECK_NAME_LIMIT`.
2. Fetchers table: `listWorkflowRuns(deps, repo, file, branch, perPage)` with `per_page=${perPage}`.
   Replace "`per_page=20` is `THRESHOLDS.runsPerWorkflow`; import it rather than repeating it." with
   "activity.ts passes `THRESHOLDS.runsPerWorkflow` (20). The adapter imports only types from
   `core/`."
3. Error mapping: add the 401 bullet (ux-r0-3) before the 403/429 bullet.
4. rules.ts snippet: `truncateText`; `prStatus(failingCheckCount: number, …)` with the count reason.
5. Parity table, `pr_status` row → "`prStatus`, `mergeable` from REST via `mergeableFrom` | Same
   status. Differs on purpose: the reason counts failing checks (`2 failing checks`) instead of
   naming them, and `failing_checks` keeps 3 names of at most 40 characters, because check names
   are contributor-controlled on fork PRs".
6. The "Verified" note under the parity table: code-r1-1 wording.
7. Data schemas: `StatusSchema`, `PrItemSchema` (`failing_checks`, `failing_check_count`, `reason`),
   `failure_issues`, the two `omitted` descriptions.
8. Collectors: summary and workflows read `(getRepo ∥ listWorkflows) → listWorkflowRuns`; prs builds
   `failing_checks`, `failing_check_count` and `prStatus(failing.length, …)`.
9. Summary strings: the issues and prs `omitted` clauses (ux-r0-2), and the workflows
   `Only the first 12 are listed; N more are not.` sentence (ux-r0-5).
10. Capability description: the text above.
11. Caps and the 8 KB limit: replace the "Text built from caller-controlled strings" paragraph with:
    "Text built from caller-controlled strings is bounded at the source. Failure units are limited
    to 72 characters, only `OPS_OWNER`'s issues count, and the summary names at most
    `FAILURE_ITEM_LIMIT` of them. PR titles are cut to 80 characters. Check names (chosen by the PR's
    workflow file on fork PRs) are cut to 3 names of 40 characters and never appear in `reason`
    or the summary. Measured (spec #46 test): 10 PRs with 200-character titles and 100 failing
    200-character checks each give a `kind=prs` envelope of N bytes. Non-ASCII text can take up
    to 3 bytes per character, so the guard's `result_too_large` remains the backstop." (N is the
    figure the size test measures; the PR reports it.)
12. Acceptance criteria: "`/mcp` lists `meta_ping`, `pkg_status` and `ops_activity`" →
    "`/mcp` lists exactly the meta, pkg and ops tools"; the token criterion's status list gains 401.
13. Risks, "Rate limit" bullet, append: "Since #11 the Worker rate-limits each client address
    (IPv6 by /64) on `/mcp` and `/api`, and the Cache API is verified on the workers.dev hostname
    (spec #46)."
14. Fixtures: after "An unknown file throws", add "(any non-directory entry that `suffixFor`
    does not map)". Document `githubRoutes(dir?)`.

### Transports, upstream calls and fixtures

No transport change. `ops_activity` stays the MCP tool on `/mcp` and `/mcp/ops` and
`GET /api/v1/ops/activity?kind=…&repo=…` on REST; the only output schema change is above
(security-r0-2). No upstream URL changes, so no fixture is recorded or edited. The new scenarios
are synthetic inline routes over `githubRoutes()`.

## Acceptance criteria

- [ ] `src/upstreams/github.ts` has no non-type import from `../core/`.
      `test/upstreams/imports.test.ts` passes for every `src/upstreams/*.ts`.
- [ ] `listWorkflowRuns(deps, 'bioc-website', 'links.yml', 'main', 20)` requests exactly
      `…/bioc-website/actions/workflows/links.yml/runs?branch=main&per_page=20&exclude_pull_requests=true`.
- [ ] `/mcp` (built with `pkgModule` and `opsModule`) lists exactly the meta, pkg and ops tool
      names plus the example tool; `/mcp/ops` lists exactly `['ops_activity']`.
- [ ] `MS_PER_DAY` no longer appears in `activity.ts`; `WEBSITE_SHA` no longer appears in
      `test/`.
- [ ] `githubRoutes(dir)` throws `Unknown GitHub fixture: bioc-x/notes.txt` for a stray non-JSON
      file, and maps every file under `test/fixtures/github/*/`.
- [ ] The token tests cover 401, 403, 404, 500, timeout and network-error through REST and MCP,
      and assert that no `console.*` argument contains the sentinel, in the REST/MCP tests too.
- [ ] `readWorkflows` requests the workflows list before the repo response resolves (the
      concurrency test).
- [ ] `expectTypeOf<Of<'failures'>['repo']>().toEqualTypeOf<'bioc-edge'>()` typechecks.
- [ ] `tools/list` on `/mcp/ops`: `JSON.stringify(tool)` does not contain `bioc-health`, and
      `tool.description` contains `every workflow when repo is given; without repo, only those that fail or warn`.
- [ ] `kind=issues&repo=bioc-infrastructure` summary contains
      `more are not (see https://github.com/seandavi/bioc-infrastructure/issues).`; the 12-PR
      bioc-mcp case contains `2 older PRs were not checked (see https://github.com/seandavi/bioc-mcp/pulls).`;
      all-repo calls still say `pass repo to narrow`.
- [ ] A 401 with a token is `upstream_error` with exactly
      `GitHub rejected this server's GITHUB_TOKEN (HTTP 401); the operator must replace the secret. Try again later.`;
      without a token a 401 message does not mention `GITHUB_TOKEN`.
- [ ] The 15-workflow case's summary contains `Only the first 12 are listed; 3 more are not.`
- [ ] PR items carry `failing_check_count`. `failing_checks` holds at most 3 names of at most 40
      characters, and `reason` counts checks (`'2 failing checks; merge conflicts'`). One PR with
      100 failing 200-character checks, and 10 such PRs with 200-character titles, keep
      `kind=prs` and `kind=prs&repo=bioc-mcp` under 8,192 bytes, and no check name of 40
      characters appears in `summary`.
- [ ] The failure flood test runs `summary` with `{}` and `{ repo: 'bioc-edge' }`, both under
      8,192 bytes.
- [ ] `rateLimitKey` gives every key in the table; two addresses in one /64 reach the limiter with
      one key, and a neighbouring /64 with another.
- [ ] `docs/deploy.md` §1, §2, §4, §7 and §8 read as specified; no line in it uses
      `$CLOUDFLARE_API_TOKEN` for the analytics query.
- [ ] Specs 9 and 11 carry every edit listed above; README carries its three edits.
- [ ] `npm test`, `npm run typecheck` and `npm run build` pass.
- [ ] The PR body repeats the outcome table and lists the envelope bytes per kind on the fixtures,
      plus the 10-hostile-PR figure.

### Needs a human (after merge)

- [ ] Create a Cloudflare Account API token with only Workers Scripts: Edit and Account Settings:
      Read. Add it as a new version of GSM `cdsci-bioc-mcp-cloudflare-deploy-token`, copy it with
      the §3 `gh secret set` line, and run Deploy by `workflow_dispatch`. If it succeeds, revoke the
      old token. If wrangler reports a missing permission, add only that one and record it in §2.
- [ ] Create `cdsci-bioc-mcp-analytics-token` (Account Analytics: Read only) in GSM, with the §2
      labels and annotations.

## Test plan

Everything runs under `npm test` in Node, with no network:

- `test/upstreams/imports.test.ts` (new): the seam check (code-r0-4).
- `test/upstreams/github.test.ts`: the `perPage` URL; 401 with and without a token; WEBSITE_SHA
  removed; `githubRoutes` stray-file throw and full mapping (code-r0-7).
- `test/core/ops/rules.test.ts`: `prStatus` by count; `truncateText`.
- `test/core/ops/activity.test.ts`: updated issues/prs summary strings (ux-r0-2); failing-check
  bounds and the two size tests (security-r0-2); concurrency (code-r0-9); the omitted sentence
  (ux-r0-5); flood test with `{}` (code-r1-2); `expectTypeOf` (code-r0-10).
- `test/core/ops/token.test.ts`: 401 everywhere; REST/MCP timeout via `makeTestApp({ fetch })`;
  console checks in the REST/MCP tests (code-r0-8).
- `test/transports/ops.test.ts`: the exact `/mcp` tool set (code-r0-5); no `bioc-health` and the
  workflows clause in `tools/list` (ux-r0-1, ux-r0-8).
- `test/rate-limit.test.ts`: the `rateLimitKey` table and the /64 middleware case
  (security-r0-1).

Then `npm run typecheck` and `npm run build`. Docs-only items (spec 9/11 text, deploy.md,
README) are checked by review against the lists above.

## Risks

- **Overlap with #43.** #43 rewrites the messages in `githubJson` (code-r0-3), and this PR adds a
  401 branch in the same function. Whichever merges second resolves the conflict by merging
  `main` (no rebase) and keeps both: #43's wording and the 401 branch.
- **Output change for `prs`.** `reason` no longer names failing checks, and `failing_checks` is
  cut to 3 names. An agent that wants every name must follow the PR URL. That is intended (the
  names are contributor-controlled), and it is recorded as a parity deviation in spec 9.
- **Non-ASCII worst case.** 80-character PR titles and 40-character check names in 3-byte UTF-8
  characters can still push 10 hostile PRs past 8 KB. `assertEnvelopeSize` then fails the call
  with `result_too_large` rather than truncating. A maintainer must approve a first-time
  contributor's workflow runs before their checks exist, which limits who can do this.
- **IPv6 parsing is hand-written.** Anything it cannot parse is used as is, which is the old
  behaviour, so a parser bug can only reduce the protection, never refuse a request.
  IPv4-embedded addresses key by their IPv4 part.
- **Deploy-token permissions are verified against API docs, not against a run.** The
  Needs-a-human step confirms them. Until the swap the current template token keeps working.
- **Spec edits are by hand.** Specs 9 and 11 describe merged work. The lists above say which
  passages change; review checks them.
