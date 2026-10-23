# Spec #9: `ops_activity`, issues, PRs and workflows across the bioc-* repos

Issue: [seandavi/bioc-mcp#9](https://github.com/seandavi/bioc-mcp/issues/9).
Project design: [proposal-mcp.qmd](https://github.com/seandavi/bioc-infrastructure/blob/spec/mcp/proposal-mcp.qmd).
Conventions: [AGENTS.md](../../AGENTS.md). Builds on the scaffold ([spec #2](2-scaffold.md),
[spec #15](15-scaffold-followups.md)) and follows the shape of [spec #6](6-pkg-status.md).

The classifications mirror bioc-infrastructure `health/bioc_health/` at commit
[`223af2a`](https://github.com/seandavi/bioc-infrastructure/tree/223af2a2714dd2476b33583d03ce4de4d229033a/health)
(the last change to `rules.py`, `sources/issues.py`, `sources/actions.py`, `crossref.py` and
`config.toml`; `origin/main` is `256fd62` on 2026-10-22).

Every GitHub shape below was checked on 2026-10-22 against the live API for all nine repos (`gh api`,
authenticated, plus unauthenticated `curl` for headers). Notes marked **Verified** record behaviour
the implementer must account for. Notes marked **Inferred** are not verified. No new npm package
is needed.

## Goal

The `ops` module and its one capability, `ops_activity(repo?, kind)`, over the public `seandavi/bioc-*`
repos listed in config. One call answers, per `kind`:

- **`summary`** (default): per repo, open issues and PRs (counts, newest, stale), default-branch
  workflows by status and which need attention, and the open `<unit> is failing` issue count in
  `bioc-edge`.
- **`issues`**: open issues, newest first, with age, staleness (untouched > 30 days) and "new"
  (opened in the last 7 days).
- **`prs`**: open PRs with failing checks, merge conflicts and staleness (non-draft, untouched > 14
  days), classified `ok`/`info`/`warn` exactly as bioc-health does.
- **`workflows`**: each default-branch workflow's latest conclusion, failure streak and last success
  in its 20 newest runs, classified `ok`/`info`/`warn`/`fail` exactly as bioc-health does.
- **`failures`**: the open `<unit> is failing` issues that `bioc-notify@`
  (`bioc-edge/notify-failure.sh`) files in `bioc-edge`.

GitHub is read with a token that has no repository permissions (Worker secret `GITHUB_TOKEN`,
5,000 requests/h). Without it, requests go out unauthenticated and the Worker logs one warning at
start-up. The token never appears in output, logs or errors.

## Non-goals

- Anything in bioc-health that needs non-public data or more GitHub calls than the issue asks for:
  the systemd cross-reference (`crossref.py`: whether a `<unit> is failing` issue's unit has
  recovered; the unit state lives only on onclappc02), workflow **schedule staleness** (needs each
  workflow's YAML: one contents call per workflow), failed-job and log-tail evidence for failing
  runs, and the closed-issue / merged-PR activity lists.
- Writes of any kind (re-running workflows, closing stale failure issues). The proposal puts those
  in the Factory layer.
- Pagination (`cursor`) and a caller-chosen `limit`. Lists are capped (see [Caps](#caps-and-the-8-kb-limit))
  and report how many items were left out. More than 100 open issues or PRs in one repo is reported
  as `truncated`, not paged.
- GraphQL. It needs a token (dev must work without one) and a POST; `fetchUpstream` is GET-only.
- Changes to `src/upstreams/http.ts`, `src/upstreams/cache.ts`, `src/envelope.ts`, `src/errors.ts`
  or the transports. The MCP `ttlMs` hint.
- An `ops_health` tool (proposal v1, gap 2).

## Design

### Files

```
src/upstreams/github.ts            NEW  GITHUB_BASE_URL, githubUpstream, githubRepoApiUrl(),
                                        githubTokenWarning(), the GitHub zod schemas and types,
                                        getRepo(), listOpenIssues(), listOpenPulls(), getPull(),
                                        listCheckRuns(), getCombinedStatus(), listWorkflows(),
                                        listWorkflowRuns()
src/core/ops/config.ts             NEW  OPS_OWNER, OPS_REPOS, OpsRepo, EXPERIMENTAL_REPOS,
                                        FAILURE_ISSUE_REPO, THRESHOLDS, OPS_KINDS, OpsKind, item caps,
                                        FAILING_CHECK_LIMIT, CHECK_NAME_LIMIT
src/core/ops/rules.ts              NEW  the bioc-health classifications, pure: HealthStatus,
                                        FAILED_CONCLUSIONS, actionsStatus(), prChecksFailing(),
                                        Mergeable, mergeableFrom(), prStatus(), ageDays(),
                                        activitySince(), summarizeRuns(), FAILURE_ISSUE_TITLE,
                                        truncateText(), truncateTitle()
src/core/ops/activity.ts           NEW  opsActivity capability, OpsActivityDataSchema, the per-kind
                                        collectors and summary text
src/core/ops/index.ts              NEW  opsModule
src/core/registry.ts                    modules = [metaModule, pkgModule, opsModule]
src/index.ts                            log githubTokenWarning(env) once, when the app is built
test/support/app.ts                     makeTestApp gains `env` and `fetch` options
test/support/github-routes.ts      NEW  fixture file → URL map for the recorded GitHub fixtures
test/upstreams/github.test.ts      NEW
test/upstreams/imports.test.ts     NEW  adapters import core only as types (spec #46)
test/core/ops/rules.test.ts        NEW
test/core/ops/activity.test.ts     NEW
test/core/ops/token.test.ts        NEW  the token never leaks; headers are sent
test/transports/ops.test.ts        NEW  REST and MCP over opsModule
test/fixtures/github/RECORDED_AT   NEW  recording instant, ISO 8601, one line
test/fixtures/github/<repo>/…      NEW  projected GitHub responses, one tree per repo (see Fixtures)
```

Import zod as `import * as z from 'zod'`. Build every upstream path with `pathSegment()` for each
value in a path segment (repo, PR number, sha, workflow file), and fetch only through
`fetchUpstreamJson`.

### `src/core/ops/config.ts`

Copied from bioc-health `config.toml` (`owner`, `repos`, `experimental_repos`,
`failure_issue_repo`, `activity_window_days`, `[thresholds]` `pr_stale_days` and
`issue_stale_days`), plus `bioc-mcp`, which the issue adds and bioc-health does not list.

```ts
export const OPS_OWNER = 'seandavi';

/** Order is the output order. bioc-health's list plus bioc-mcp. */
export const OPS_REPOS = [
  'bioc-edge',
  'bioc-traffic',
  'bioc-infrastructure',
  'bioc-registry',
  'bioc-website',
  'bioc-build',
  'bioc-manifest',
  'bioc-intelligence',
  'bioc-mcp',
] as const;
export type OpsRepo = (typeof OPS_REPOS)[number];

/** Prototypes: an Actions failure caps at 'warn' (bioc-health experimental_repos). */
export const EXPERIMENTAL_REPOS: ReadonlySet<OpsRepo> = new Set(['bioc-build', 'bioc-manifest']);

/** Where bioc-notify@ (bioc-edge/notify-failure.sh) files "<unit> is failing" issues. */
export const FAILURE_ISSUE_REPO = 'bioc-edge' satisfies OpsRepo;

export const THRESHOLDS = {
  prStaleDays: 14,
  issueStaleDays: 30,
  activityWindowDays: 7,
  runsPerWorkflow: 20, // bioc-health: gh run list -L 20
} as const;

export const OPS_KINDS = ['summary', 'issues', 'prs', 'workflows', 'failures'] as const;
export type OpsKind = (typeof OPS_KINDS)[number];

export const ISSUE_ITEM_LIMIT = 15;
export const PR_ITEM_LIMIT = 10;
export const WORKFLOW_ITEM_LIMIT = 12;
export const FAILURE_ITEM_LIMIT = 15;
export const SUMMARY_PROBLEM_LIMIT = 5; // workflows named in the summary text
export const FAILING_CHECK_LIMIT = 3; // names kept per PR in failing_checks
export const CHECK_NAME_LIMIT = 40; // characters per kept name
```

**Verified (2026-10-22):** all nine repos are public, their default branch is `main`, and they hold
25 workflow files (bioc-traffic has none), 114 open issues and 7 open PRs.

### `src/upstreams/github.ts`

```ts
export const GITHUB_BASE_URL = 'https://api.github.com/repos/seandavi/';

export const githubUpstream: Upstream = {
  id: 'github',
  name: 'GitHub REST API',
  baseUrl: GITHUB_BASE_URL,
  ttlSeconds: 120,
  description:
    'GitHub REST API, read-only and limited to seandavi/* repositories: open issues and pull ' +
    'requests, their check runs and commit statuses, and GitHub Actions workflows and runs.',
};

/** https://api.github.com/repos/seandavi/<repo>: the provenance URL for everything read about a repo. */
export function githubRepoApiUrl(repo: string): string; // new URL(pathSegment(repo), GITHUB_BASE_URL).href

/** The start-up warning when no token is configured; undefined when one is. */
export function githubTokenWarning(env: CapabilityEnv): string | undefined;
```

The `baseUrl` ends at the owner, so `fetchUpstream`'s SSRF guard keeps every request, and any
redirect it follows, inside `https://api.github.com/repos/seandavi/`. That is also what keeps the
`Authorization` header on that prefix.

`githubTokenWarning` returns exactly
`'GITHUB_TOKEN is not set: GitHub requests are unauthenticated and limited to 60 per hour per IP. Set it with `wrangler secret put GITHUB_TOKEN` (or in .dev.vars for wrangler dev).'`
when `env.GITHUB_TOKEN?.trim()` is empty or undefined, and `undefined` otherwise. It never includes
the token.

#### Headers and the token

A private `githubDeps(deps: Deps): Deps` returns `{ ...deps, fetch }`, where `fetch(request)` builds
`new Request(request, { headers })` with `headers = new Headers(request.headers)` plus:

- `accept: application/vnd.github+json`
- `x-github-api-version: 2022-11-28` (**Verified:** GitHub echoes `x-github-api-version-selected: 2022-11-28`)
- `authorization: Bearer ${token}` only when `token = deps.env.GITHUB_TOKEN?.trim()` is non-empty

and passes it to `deps.fetch`. `new Request(request, init)` keeps the original's URL, `redirect:
'manual'` and timeout `signal`. The `user-agent` set by `fetchUpstream` stays. Nothing else reads the
token: no error message, log line or cache entry is built from headers (`fetchUpstream` caches only
the body, content type and timestamps).

#### Schemas

Only the fields this module reads. `z.object` strips the rest.

```ts
const UserSchema = z.object({ login: z.string() }).nullable(); // null for deleted users

export const GithubRepoSchema = z.object({ default_branch: z.string() });

export const GithubIssueSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  html_url: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  comments: z.number().int(),
  labels: z.array(z.object({ name: z.string() })),
  user: UserSchema,
  draft: z.boolean().nullish(), // PRs only
  pull_request: z.object({}).optional(), // present ⇔ the item is a PR
});
export type GithubIssue = z.infer<typeof GithubIssueSchema>;

export const GithubPullSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  html_url: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  draft: z.boolean(),
  user: UserSchema,
  head: z.object({ sha: z.string(), ref: z.string() }),
});
export type GithubPull = z.infer<typeof GithubPullSchema>;

export const GithubPullDetailSchema = z.object({
  number: z.number().int(),
  mergeable: z.boolean().nullable(), // null while GitHub computes it
});

export const GithubCheckRunsSchema = z.object({
  total_count: z.number().int(),
  check_runs: z.array(z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable() })),
});

export const GithubCombinedStatusSchema = z.object({
  statuses: z.array(z.object({ context: z.string(), state: z.string() })),
});

export const GithubWorkflowSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  path: z.string(),
  state: z.string(), // 'active', 'disabled_manually', 'disabled_inactivity', …
  html_url: z.string(),
});
export type GithubWorkflow = z.infer<typeof GithubWorkflowSchema>;

export const GithubWorkflowRunSchema = z.object({
  id: z.number().int(),
  status: z.string().nullable(), // 'completed', 'in_progress', 'queued', …
  conclusion: z.string().nullable(),
  event: z.string(),
  created_at: z.string(),
  html_url: z.string(),
  display_title: z.string(),
});
export type GithubWorkflowRun = z.infer<typeof GithubWorkflowRunSchema>;
```

**Verified:** in the issues list, PR items carry `pull_request` (an object) and `draft`; issue items
have neither. Labels are objects with `name`. Run objects carry the fields above; `status` and
`conclusion` were never null on completed runs.

#### Fetchers

Every fetcher is `async (deps, repo: string, …) => Promise<{ response: UpstreamResponse; data: T }>`,
and runs `fetchUpstreamJson(githubDeps(deps), githubUpstream, path)` then `schema.safeParse(json)`.

| Function | `path` (relative to `GITHUB_BASE_URL`) | `data` |
|---|---|---|
| `getRepo(deps, repo)` | `${r}` | `GithubRepo` |
| `listOpenIssues(deps, repo)` | `${r}/issues?state=open&per_page=100&sort=created&direction=desc` | `GithubIssue[]` (issues and PRs) |
| `listOpenPulls(deps, repo)` | `${r}/pulls?state=open&per_page=100&sort=created&direction=desc` | `GithubPull[]` |
| `getPull(deps, repo, number)` | `${r}/pulls/${pathSegment(String(number))}` | `GithubPullDetail` |
| `listCheckRuns(deps, repo, sha)` | `${r}/commits/${pathSegment(sha)}/check-runs?per_page=100` | `GithubCheckRuns` |
| `getCombinedStatus(deps, repo, sha)` | `${r}/commits/${pathSegment(sha)}/status` | `GithubCombinedStatus` |
| `listWorkflows(deps, repo)` | `${r}/actions/workflows?per_page=100` | `GithubWorkflow[]` (the `workflows` array) |
| `listWorkflowRuns(deps, repo, file, branch, perPage)` | `${r}/actions/workflows/${pathSegment(file)}/runs?branch=${encodeURIComponent(branch)}&per_page=${perPage}&exclude_pull_requests=true` | `GithubWorkflowRun[]` (the `workflow_runs` array) |

where `r = pathSegment(repo)`. Query strings are written in exactly this order, so URLs match the
fixture routes. activity.ts passes `THRESHOLDS.runsPerWorkflow` (20) as `perPage`. The adapter
imports only types from `core/` (`test/upstreams/imports.test.ts` enforces it).

Error mapping, in a private `githubJson(deps, repo, path, schema, what)` that every fetcher uses (`repo` appears only in the unexpected-shape message below):

- `CapabilityError` with `details.status` 401 and a non-blank `GITHUB_TOKEN` → rethrow as
  `CapabilityError('upstream_error', "GitHub rejected this server's GITHUB_TOKEN (HTTP 401); the operator must replace the secret. Try again later.", details)`.
  Without a token a 401 is not about our secret and propagates unchanged. The message names the
  variable, never its value.
- `CapabilityError` with `details.status` 403 or 429 → rethrow as
  `CapabilityError('upstream_error', \`GitHub refused the request (HTTP ${status}), most likely its rate limit${tokenless ? '; this server has no GITHUB_TOKEN, so the limit is 60 requests per hour' : ''}. Try again later.\`, details)`.
- `CapabilityError` with `code === 'not_found'` → rethrow as
  `CapabilityError('upstream_error', \`GitHub has nothing at ${details.url}; the repository, PR or workflow may have been removed, renamed or made private.\`, details)`.
  Every repo is validated against `OPS_REPOS`, so a 404 is a stale config or a vanished PR or
  commit, never the caller's mistake.
- Any other `CapabilityError` propagates unchanged.
- `safeParse` fails → `CapabilityError('upstream_error', \`GitHub returned an unexpected ${what} for seandavi/${repo}.\`, { upstream: 'github', url: response.url })`,
  with `what` one of `repository`, `issue list`, `pull request list`, `pull request`, `check run list`,
  `commit status`, `workflow list`, `workflow run list`.

**Verified:** list endpoints send no `Last-Modified` (the repo endpoint does), so `as_of` is the
fetch time. Responses carry `cache-control: private, max-age=60` (authenticated) or `public, max-age=60`;
`fetchUpstream` ignores both and caches for `ttlSeconds`.

### `src/core/ops/rules.ts`

Pure functions, no I/O. The header comment names the bioc-health files and commit `223af2a` they
mirror and says to change both together.

```ts
export type HealthStatus = 'ok' | 'info' | 'warn' | 'fail';

/** bioc-health FAILED_CONCLUSIONS. */
export const FAILED_CONCLUSIONS: ReadonlySet<string> = new Set(['failure', 'timed_out', 'startup_failure']);

/** bioc-health actions_status. */
export function actionsStatus(conclusion: string | null, experimental: boolean): HealthStatus;
// null → 'info'; 'success' | 'skipped' | 'neutral' → 'ok';
// FAILED_CONCLUSIONS → experimental ? 'warn' : 'fail'; anything else (cancelled, action_required, new values) → 'warn'

/** bioc-health pr_checks_failing over REST: check runs first, then commit statuses, in response order. */
export function prChecksFailing(
  checkRuns: readonly { name: string; conclusion: string | null }[],
  statuses: readonly { context: string; state: string }[],
): string[];
// verdict = conclusion ?? '' for a check run, state for a status; failing when
// verdict.toUpperCase() is in {FAILURE, TIMED_OUT, ACTION_REQUIRED, STARTUP_FAILURE, ERROR}.
// Returns check-run names, then status contexts.

export type Mergeable = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
/** REST mergeable (true | false | null) → the GraphQL value bioc-health stores. */
export function mergeableFrom(value: boolean | null): Mergeable;

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
): { status: HealthStatus; reason: string };
// problems = [count > 0 ? `${count} failing check${count === 1 ? '' : 's'}` : none, mergeable === 'CONFLICTING' ? 'merge conflicts' : none]
// problems non-empty → { 'warn', problems.join('; ') }
// !isDraft && updatedAgeDays > THRESHOLDS.prStaleDays → { 'info', `no activity for ${Math.round(updatedAgeDays)} days` }
// else { 'ok', 'ok' }

/** Days between iso and now, rounded to one decimal (bioc-health _age_days). */
export function ageDays(iso: string, now: Date): number; // Math.round((now - Date.parse(iso)) / 86_400_000 * 10) / 10

/** First day of the activity window, YYYY-MM-DD (bioc-health `since`). */
export function activitySince(now: Date): string;
// new Date(now.getTime() - THRESHOLDS.activityWindowDays * 86_400_000).toISOString().slice(0, 10)
// An issue is new when issue.created_at.slice(0, 10) >= activitySince(now).

/** bioc-health _workflow, minus the YAML, schedule and failure evidence. `runs` newest first. */
export function summarizeRuns(runs: readonly GithubWorkflowRun[]): {
  latest_conclusion: string | null; // conclusion of the first run with status 'completed'
  latest_run_url: string | null; // its html_url
  streak: number; // leading completed runs whose conclusion is in FAILED_CONCLUSIONS
  last_success_at: string | null; // created_at of the first completed run with conclusion 'success'
  newest_run_at: string | null; // runs[0].created_at, completed or not
  runs_examined: number; // runs.length (≤ 20)
};

/**
 * bioc-health crossref TITLE, with the unit bounded to systemd's name charset and 72 characters in
 * all, because anyone can title an issue in a public repo. Group 1 is the unit.
 */
export const FAILURE_ISSUE_TITLE = /^([A-Za-z0-9:_.@\-]{1,64}\.service) is failing$/;

/** At most `limit` UTF-16 code units: the first limit − 1 plus '…' when longer. */
export function truncateText(text: string, limit: number): string;

/** At most 80 UTF-16 code units: the first 79 plus '…' when longer. */
export function truncateTitle(title: string): string; // truncateText(title, 80)
```

Rounding: Python's `round` rounds halves to even and `Math.round` rounds them up, so an age exactly
on a .x5 boundary can differ in its last digit. As in bioc-health, the stale comparisons (`> 14`,
`> 30`) use the rounded age, so the two can disagree only when an age lands exactly on such a tie
next to the threshold. Accept it.

**Parity with bioc-health:**

| bioc-health | Here | Same answer? |
|---|---|---|
| `actions_status(latest conclusion, experimental)` | `actionsStatus`, on `workflows[].status` | Yes |
| streak, `last_success_at`, `newest_run_at` over `gh run list -w file -b default -L 20` | `summarizeRuns` over `…/workflows/{file}/runs?branch={default}&per_page=20` | Yes |
| workflow `state != active` → WARN, no runs read | same: `status 'warn'`, `reason "workflow is ${state}"`, runs not fetched | Yes |
| workflows outside `.github/workflows/` skipped | same filter on `path` | Yes |
| schedule staleness (cron) | not computed | No (non-goal) |
| `pr_checks_failing(statusCheckRollup)` | `prChecksFailing(check-runs, combined status)` | Yes, assuming the rollup is the head commit's latest check runs and statuses |
| `pr_status(failing, mergeable, updated age, draft)` | `prStatus`, `mergeable` from REST via `mergeableFrom` | Same status. Differs on purpose: the reason counts failing checks (`2 failing checks`) instead of naming them, and `failing_checks` keeps 3 names of at most 40 characters, because check names are contributor-controlled on fork PRs |
| stale issues: `updated_at` age > `issue_stale_days` | same | Yes |
| new issues: `created_at[:10] >= since` | same | Yes |
| `truncated: len == ISSUE_LIMIT` (200 issues, PRs listed apart) | `truncated: items.length === 100` over the mixed issues+PRs list | Same rule, smaller page (one call) |
| crossref `TITLE` over open `failure_issue_repo` issues | `FAILURE_ISSUE_TITLE` over open, non-PR `bioc-edge` issues opened by `OPS_OWNER`; first issue per unit kept, as `filed.setdefault` does | Yes, without the unit-state comparison. Differs on purpose: crossref.py trusts the repo's issues, but this server shows the text to a model and `bioc-edge` is public, so titles from other accounts are ignored and the unit is bounded |

**Verified:** the `<unit> is failing` issues are authored by `seandavi` (the account `gh` runs as on
the host) with label `bug`, not by a `bioc-notify` account. crossref.py uses the title as the only
marker; this server also requires `user.login === OPS_OWNER` (see the row above). `notify-failure.sh` comments on the open issue on each repeat failure and nothing
closes it on recovery.

### `src/core/ops/activity.ts`

#### Input

```ts
input: z.object({
  repo: z
    .enum(OPS_REPOS)
    .optional()
    .describe("One repo (owner seandavi), e.g. 'bioc-registry'. Omit for all of them"),
  kind: z
    .enum(OPS_KINDS)
    .default('summary')
    .describe(
      "'summary' (default): counts per repo; 'issues'; 'prs'; 'workflows': default-branch GitHub Actions; " +
        "'failures': open '<unit> is failing' issues in bioc-edge",
    ),
}),
```

**Verified:** a throwaway module with this exact input shape and a `z.discriminatedUnion` data
schema passed `validateRegistry`, served REST (`?kind=b&repo=y` 200, `?repo=z` 400 `invalid_input`),
appeared in `/api/openapi.json`, listed an MCP `outputSchema` with `oneOf`, and returned
`structuredContent` over MCP. The script was not committed.

#### Data (output) schema

`data` is a discriminated union on `kind`. Shared pieces:

```ts
const StatusSchema = z
  .enum(['ok', 'info', 'warn', 'fail'])
  .describe(
    "Classification by the bioc-infrastructure health report's rules: 'fail' and 'warn' need attention, 'info' is worth knowing",
  );

const RepoErrorSchema = z
  .string()
  .nullable()
  .describe('Why this repo could not be read; its other fields are then zero or empty. null when read');

const IssueItemSchema = z.object({
  repo: z.string(),
  number: z.number().int(),
  title: z.string().describe('At most 80 characters'),
  url: z.string(),
  labels: z.array(z.string()),
  age_days: z.number().describe('Days since opened'),
  updated_age_days: z.number().describe('Days since last updated'),
  stale: z.boolean().describe('Untouched for more than 30 days'),
  new: z.boolean().describe('Opened in the last 7 days'),
});

const PrItemSchema = z.object({
  repo: z.string(),
  number: z.number().int(),
  title: z.string().describe('At most 80 characters'),
  url: z.string(),
  draft: z.boolean(),
  age_days: z.number(),
  updated_age_days: z.number(),
  mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']).describe('UNKNOWN while GitHub computes it'),
  failing_checks: z
    .array(z.string())
    .describe('Up to 3 failing check runs and commit statuses on the head commit (check runs first), each at most 40 characters'),
  failing_check_count: z.number().int().describe('All failing check runs and commit statuses on the head commit'),
  status: StatusSchema,
  reason: z.string().describe("e.g. '2 failing checks; merge conflicts', 'no activity for 67 days', 'ok'"),
});

const WorkflowItemSchema = z.object({
  repo: z.string(),
  file: z.string().describe("Workflow file name, e.g. 'test.yml'"),
  state: z.string().describe("'active', or why it is disabled"),
  status: StatusSchema,
  reason: z.string().describe("e.g. 'latest failure (20 in a row)', 'no completed runs on main'"),
  latest_conclusion: z.string().nullable(),
  latest_run_url: z.string().nullable(),
  streak: z.number().int().describe('Consecutive failed runs ending with the latest, within the runs examined'),
  last_success_at: z.string().nullable().describe('null if no success among the runs examined'),
  newest_run_at: z.string().nullable(),
  runs_examined: z.number().int().describe('Newest default-branch runs read, at most 20'),
});

const FailureItemSchema = z.object({
  unit: z.string().describe("systemd unit, e.g. 'bioc-sync.service'"),
  number: z.number().int(),
  url: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  comments: z.number().int().describe('Comments, one per repeat failure report plus any human ones'),
});
```

Per kind:

```ts
const SummaryDataSchema = z.object({
  kind: z.literal('summary'),
  repos: z.array(
    z.object({
      repo: z.string(),
      error: RepoErrorSchema,
      open_issues: z.number().int(),
      stale_issues: z.number().int().describe('Untouched for more than 30 days'),
      new_issues: z.number().int().describe('Opened in the last 7 days'),
      open_prs: z.number().int(),
      draft_prs: z.number().int(),
      stale_prs: z.number().int().describe('Non-draft PRs untouched for more than 14 days'),
      truncated: z.boolean().describe('100 or more open issues and PRs; counts cover the newest 100'),
      newest: z
        .object({
          kind: z.enum(['issue', 'pr']),
          number: z.number().int(),
          title: z.string(),
          url: z.string(),
          created_at: z.string(),
        })
        .nullable()
        .describe('The most recently opened issue or PR'),
      workflows: z.object({
        total: z.number().int(),
        ok: z.number().int(),
        info: z.number().int(),
        warn: z.number().int(),
        fail: z.number().int(),
        needs_attention: z.array(z.string()).describe("Files of workflows whose status is 'fail' or 'warn'"),
      }),
      failure_issues: z
        .number()
        .int()
        .nullable()
        .describe("Units with an open '<unit> is failing' issue; only for bioc-edge (null for other repos, or when bioc-edge could not be read)"),
    }),
  ),
});

const IssuesDataSchema = z.object({
  kind: z.literal('issues'),
  repos: z.array(
    z.object({
      repo: z.string(),
      error: RepoErrorSchema,
      open: z.number().int(),
      stale: z.number().int(),
      new: z.number().int(),
      truncated: z.boolean(),
    }),
  ),
  items: z.array(IssueItemSchema).describe('Newest first, at most 15 across all repos'),
  omitted: z.number().int().describe('Open issues not listed because of the cap'),
});

const PrsDataSchema = z.object({
  kind: z.literal('prs'),
  repos: z.array(
    z.object({
      repo: z.string(),
      error: RepoErrorSchema,
      open: z.number().int(),
      draft: z.number().int(),
      stale: z.number().int(),
      truncated: z.boolean(),
    }),
  ),
  items: z.array(PrItemSchema).describe('Newest first, at most 10 across all repos'),
  omitted: z.number().int().describe('Open PRs not listed (and not checked) because of the cap'),
});

const WorkflowsDataSchema = z.object({
  kind: z.literal('workflows'),
  listed: z
    .enum(['all', 'needs_attention'])
    .describe("'all' when repo is given; otherwise only workflows whose status is 'fail' or 'warn'"),
  repos: z.array(
    z.object({
      repo: z.string(),
      error: RepoErrorSchema,
      default_branch: z.string().nullable(),
      experimental: z.boolean().describe("Failures cap at 'warn' (a prototype repo)"),
      ok: z.number().int(),
      info: z.number().int(),
      warn: z.number().int(),
      fail: z.number().int(),
    }),
  ),
  workflows: z.array(WorkflowItemSchema).describe('Repo order, then file path; at most 12'),
  omitted: z.number().int().describe('Workflows eligible for the list but not listed because of the cap'),
});

const FailuresDataSchema = z.object({
  kind: z.literal('failures'),
  repo: z.literal('bioc-edge'),
  items: z.array(FailureItemSchema).describe('Newest first, at most 15'),
  omitted: z.number().int().describe("Units with an open '<unit> is failing' issue not listed because of the cap"),
});

export const OpsActivityDataSchema = z.discriminatedUnion('kind', [
  SummaryDataSchema,
  IssuesDataSchema,
  PrsDataSchema,
  WorkflowsDataSchema,
  FailuresDataSchema,
]);
```

`z.literal('bioc-edge')` is `z.literal(FAILURE_ISSUE_REPO)`.

#### Handler

```ts
async handler({ repo, kind }, deps) {
  if (kind === 'failures' && repo !== undefined && repo !== FAILURE_ISSUE_REPO) {
    throw new CapabilityError(
      'invalid_input',
      `"<unit> is failing" issues are filed only in ${FAILURE_ISSUE_REPO}; omit repo or pass repo=${FAILURE_ISSUE_REPO}.`,
    );
  }
  const repos: OpsRepo[] = repo ? [repo] : [...OPS_REPOS];
  const now = deps.now();
  switch (kind) { /* one collector per kind, below */ }
}
```

**Per-repo isolation (bioc-health: "one bad repo must not hide the others").** A private helper
runs one async function per repo concurrently (`Promise.all`) and gives each a `track(response)`
callback that records every `UpstreamResponse` it reads:

```ts
type RepoOutcome<T> =
  | { repo: OpsRepo; ok: true; value: T; asOf: string } // asOf = the smallest fetchedAt tracked
  | { repo: OpsRepo; ok: false; error: CapabilityError };
```

- A `CapabilityError` thrown inside one repo's function makes that repo's outcome `ok: false`.
  Its data entry gets `error: error.message`, zero counts, `null` for nullable fields, and no items.
- Any other error is a bug: rethrow it at once (→ `internal`).
- If every repo's outcome is `ok: false`, throw the first one's `CapabilityError` (config order).
  So a single-repo call fails with the upstream's own code, and a GitHub outage is a 502, not an
  empty success.

**Sources.** One per repo whose outcome is `ok`, in config order:
`{ url: githubRepoApiUrl(repo), as_of: outcome.asOf }`. Every endpoint read for that repo lives
under that URL. `as_of` is the oldest `fetchedAt` among its responses (served from cache, so up to
2 minutes old), never a `Last-Modified`. One source per repo keeps a nine-repo result about 850
bytes of provenance instead of 2.5 KB for one per endpoint.

**Collectors.** Within a repo, independent calls run concurrently; dependent ones in order.

- **summary:** `listOpenIssues` and (`getRepo` ∥ `listWorkflows`, then `listWorkflowRuns` for each
  active `.github/workflows/` workflow, concurrently) in parallel. From the issues list: issues are
  items without `pull_request`, PRs those with it. `open_issues`, `stale_issues`
  (`ageDays(updated_at) > 30`), `new_issues` (`created_at.slice(0, 10) >= activitySince(now)`),
  `open_prs`, `draft_prs` (`draft === true`), `stale_prs` (`draft !== true && ageDays(updated_at) > 14`),
  `truncated` (`items.length === 100`), `newest` = the first item (the list is newest first), with
  `truncateTitle`. `workflows` as in the workflows collector, counted by status; `needs_attention`
  lists the files with status `fail` or `warn`, in path order. `failure_issues`: for
  `FAILURE_ISSUE_REPO`, the number of distinct units from the same issues list (as in the failures
  collector); `null` for every other repo and for a repo that could not be read (`error` set), so a
  reader can tell "none open" from "could not read".
- **issues:** `listOpenIssues`. Per repo `open`, `stale`, `new`, `truncated` as above. Items: every
  non-PR issue of every repo, sorted by `created_at` descending, ties by config order then `number`
  descending; the first `ISSUE_ITEM_LIMIT` are listed (`labels` = label names, `title` truncated),
  `omitted` = the rest.
- **prs:** `listOpenPulls`. Per repo `open`, `draft`, `stale` (non-draft, `ageDays(updated_at) > 14`),
  `truncated` (`length === 100`). Sort all PRs by `created_at` descending (ties: config order, then
  `number` descending) and keep the first `PR_ITEM_LIMIT`. For each kept PR, concurrently:
  `getPull` (for `mergeable`), `listCheckRuns` and `getCombinedStatus` on `head.sha`; then
  `failing = prChecksFailing(check_runs, statuses)`, `failing_checks` = the first
  `FAILING_CHECK_LIMIT` names, each `truncateText(name, CHECK_NAME_LIMIT)`, `failing_check_count =
  failing.length`, `mergeable = mergeableFrom(...)`, and
  `{ status, reason } = prStatus(failing.length, mergeable, updated_age_days, draft)`. A detail call
  that fails makes the PR's repo `ok: false` (the whole repo, like any other read). `omitted` = PRs
  not kept; they are counted but never checked.
- **workflows:** `getRepo` ∥ `listWorkflows` (concurrently); `default_branch` from the repo, then keep `path.startsWith('.github/workflows/')`,
  sort by `path`. For each: `file = path.split('/').at(-1)`. If `state !== 'active'`: status
  `'warn'`, reason `` `workflow is ${state}` ``, all run fields null, `streak 0`, `runs_examined 0`,
  and no runs call. Otherwise `listWorkflowRuns(deps, repo, file, default_branch, THRESHOLDS.runsPerWorkflow)` (concurrently
  across workflows), `summarizeRuns(runs)`, `status = actionsStatus(latest_conclusion, EXPERIMENTAL_REPOS.has(repo))`,
  and `reason` = `` `no completed runs on ${default_branch}` `` when `latest_conclusion` is null,
  else `` `latest ${latest_conclusion}` `` + (`streak > 1` ? `` ` (${streak} in a row)` `` : ''),
  the same wording as bioc-health's finding titles. Listed: every workflow when `repo` is given
  (`listed: 'all'`), else only `fail` and `warn` ones (`listed: 'needs_attention'`); in config
  order then path, first `WORKFLOW_ITEM_LIMIT`, `omitted` = the rest of the eligible ones.
- **failures:** `listOpenIssues(deps, FAILURE_ISSUE_REPO)` (the same URL as issues and summary, so
  one cache entry). Non-PR items whose title matches `FAILURE_ISSUE_TITLE`, sorted by `created_at`
  descending, first per unit kept. Only issues whose `user.login === OPS_OWNER` count (the notifier
  posts as that account; a deleted or other user's issue is ignored). First `FAILURE_ITEM_LIMIT` listed, `omitted` the rest. A failed
  read throws (one repo).

#### Summary (the MCP text content)

`scope` is the repo name when `repo` is given, else `` `${n} repos` ``. Counts use plural `s` when
not 1. Sentences are joined with `' '`. "Problems" below are workflows with status `fail` or `warn`,
fail first, then config order and path; each is written `` `${repo}/${file} ${reason}` `` plus
`' (experimental)'` when `EXPERIMENTAL_REPOS.has(repo) && FAILED_CONCLUSIONS.has(latest_conclusion)`
(a failure capped at `warn`).
`moreSuffix(n, shown)` is `` ` and ${n - shown} more` `` when `n > shown`, else `''`. A unit list
(`unitList`) names the first `FAILURE_ITEM_LIMIT` units followed by `moreSuffix`, so the text stays
bounded however many issues are open.

- **Errors** (every kind with more than one repo, appended last when any repo failed):
  `` `Could not read ${failedRepos.join(', ')}: ${firstError.message}` `` (the message ends with its
  own period).
- **summary:**
  1. `` `${scope}: ${issues} open issues (${stale} untouched over 30 days, ${new} opened in the last 7 days) and ${prs} open PRs (${stalePrs} non-draft untouched over 14 days).` ``
  2. No problems → `'No default-branch workflow needs attention.'`; else
     `` `Workflows needing attention: ${first SUMMARY_PROBLEM_LIMIT joined '; '}${moreSuffix}.` ``
  3. When `bioc-edge` is in scope: `` `${k} open "<unit> is failing" issues in bioc-edge` `` +
     (k > 0 ? `` ` (${unitList}); nothing closes them when a unit recovers, so check before acting.` `` : `'.'`)
- **issues:** `` `${scope}: ${open} open issues, ${stale} untouched over 30 days, ${new} opened in the last 7 days.` ``
  + (items ? `` ` The ${items.length} newest are listed` `` + (omitted ? `` `; ${omitted} more are not${repo ? ` (see https://github.com/${OPS_OWNER}/${repo}/issues)` : ' (pass repo to narrow)'}` `` : '') + '.' : '')
- **prs:** `` `${scope}: ${open} open PRs (${draft} draft, ${stale} non-draft untouched over 14 days).` ``
  + listed PRs with status `warn` → `` ` Need attention: ${first 5 as `${repo}#${number} (${reason})` joined '; '}${moreSuffix}.` ``
  + (omitted ? `` ` ${omitted} older PRs were not checked${repo ? ` (see https://github.com/${OPS_OWNER}/${repo}/pulls)` : '; pass repo to narrow'}.` `` : '')
- **workflows:** `` `${scope}: ${total} default-branch workflows: ${fail} failing, ${warn} warn, ${info} with no completed run, ${ok} ok.` ``
  + the problems sentence from summary step 2
  + (omitted ? `` ` Only the first ${WORKFLOW_ITEM_LIMIT} are listed; ${omitted} more are not.` `` : '').
- **failures:** `` `${k} open "<unit> is failing" issues in bioc-edge` `` + (k > 0 ?
  `` `: ${unitList}. bioc-notify@ comments on the open issue at each failure and nothing closes it on recovery, so an open issue does not prove the unit is still failing.` `` : `'.'`)

#### Capability

```ts
export const opsActivity = defineCapability({
  module: 'ops',
  name: 'ops_activity',
  title: 'Activity across the bioc-* infrastructure repos',
  description:
    'Open issues and pull requests, default-branch GitHub Actions results, and open "<unit> is failing" ' +
    `issues across the seandavi/bioc-* infrastructure repos (${OPS_REPOS.join(', ')}). ` +
    "kind 'summary' (default) gives counts per repo and the workflows needing attention; 'issues' lists open " +
    "issues newest first, with staleness (untouched over 30 days); 'prs' lists open PRs with failing checks, " +
    "merge conflicts and staleness (over 14 days); 'workflows' gives each workflow's latest conclusion, failure " +
    "streak and last success on the default branch (every workflow when repo is given; without repo, only those " +
    "that fail or warn); 'failures' lists the '<unit> is failing' issues bioc-notify@ files in bioc-edge, which " +
    'nothing closes on recovery. repo narrows to one repo. Statuses (ok, info, warn, fail) follow the rules of ' +
    "the bioc-infrastructure health report. Public GitHub data, cached 2 minutes. For a package's build or " +
    'propagation state use pkg_status. Does not report host, service or traffic health.',
  input,
  data: OpsActivityDataSchema,
  handler,
});
```

### `src/core/ops/index.ts`

```ts
export const opsModule: Module = {
  name: 'ops',
  description: 'Issues, pull requests and GitHub Actions state across the seandavi/bioc-* infrastructure repos.',
  upstreams: [githubUpstream],
  capabilities: [opsActivity],
};
```

`src/core/registry.ts`: `export const modules: readonly Module[] = [metaModule, pkgModule, opsModule];`.

### `src/index.ts`

Build the app in an `if (!app) { … }` block instead of `app ??=`, and in it, before `createApp`:

```ts
const warning = githubTokenWarning(env);
if (warning) console.warn(warning);
```

So the warning is logged once per isolate, at start-up, and only names the variable.
`WorkerEnv.GITHUB_TOKEN` and `deps.env.GITHUB_TOKEN` already exist; #11 sets the secret.

### Transports

No changes. The scaffold derives them:

- **MCP:** tool `ops_activity` on `/mcp` and `/mcp/ops`. `structuredContent` is the envelope.
- **REST:** `GET /api/v1/ops/activity?kind=workflows&repo=bioc-website`. Both parameters optional.
- `bioc://about` and `GET /api/v1/about` list module `ops` and upstream `github` (`used_by: ['ops']`).

### Upstream calls

All under `https://api.github.com/repos/seandavi/`, cached 120 s, `as_of` = fetch time.

| Call | Example URL | Used by |
|---|---|---|
| Repo | `…/bioc-website` | summary, workflows |
| Open issues + PRs | `…/bioc-edge/issues?state=open&per_page=100&sort=created&direction=desc` | summary, issues, failures |
| Open PRs | `…/bioc-website/pulls?state=open&per_page=100&sort=created&direction=desc` | prs |
| PR | `…/bioc-website/pulls/74` | prs |
| Check runs | `…/bioc-website/commits/87c427974dd00029c68624541011b823e4d79c96/check-runs?per_page=100` | prs |
| Commit status | `…/bioc-website/commits/87c427974dd00029c68624541011b823e4d79c96/status` | prs |
| Workflows | `…/bioc-website/actions/workflows?per_page=100` | summary, workflows |
| Workflow runs | `…/bioc-website/actions/workflows/links.yml/runs?branch=main&per_page=20&exclude_pull_requests=true` | summary, workflows |

**Request budget (cold cache, all repos, 2026-10-22 data):** summary 49 GitHub requests (9 repo,
9 issues, 9 workflows, 22 runs), workflows 40, prs 30 (9 lists + 3 per PR; at most 9 + 3 ×
`PR_ITEM_LIMIT` = 39), issues 9, failures 1. With a warm cache, zero. Each cold URL also costs a
Cache API `match` and `put`, which share the subrequest quota. **Verified** (Cloudflare limits page,
2026-10-22): Workers Free allows 50 subrequests and 50 Cache API calls per request; Workers Paid
allows 10,000 subrequests and 1,000 Cache API calls. **Inferred, not verified:** `bioc-mcp` deploys to
the personal account that serves `bioc-registry.seandavi.workers.dev`, which bioc-infrastructure's
`cloudflare-account-migration.qmd` says holds Workers Paid. See [Risks](#risks).

**Verified sizes:** a workflow-runs page of 20 is about 250 KB (each run embeds the repository
twice); the nine issue lists total about 650 KB (bodies included). A cold all-repo summary reads
about 6 MB of JSON.

### Caps and the 8 KB limit

Measured on the 2026-10-22 data with the shapes above: summary data for all nine repos about 4.0 KB;
nine sources about 0.85 KB; issues with the 15 longest items about 4.3 KB of items. A PR item is
about 330 bytes (10 → 3.3 KB), a workflow item about 330 bytes (12 → 4 KB). Every kind stays under
about 7 KB with the caps. The envelope guard throws `result_too_large` rather than truncating if
labels or error messages ever push one over.

Text built from caller-controlled strings is bounded at the source. Failure units are limited to 72
characters, only `OPS_OWNER`'s issues count, and the summary names at most `FAILURE_ITEM_LIMIT` of
them. PR titles are cut to 80 characters. Check names (chosen by the PR's workflow file on fork
PRs) are cut to 3 names of 40 characters and never appear in `reason` or the summary. Measured
(spec #46 test): 10 PRs with 200-character titles and 100 failing 200-character checks each give a
`kind=prs` envelope of 7,156 bytes (all repos). Non-ASCII text can take up to 3 bytes per
character, so the guard's `result_too_large` remains the backstop.

### Fixtures

Responses are **projected** to the fields the schemas read (bodies, embedded repositories and
actors dropped), because the raw pages total about 7 MB. Projection keeps every field the code
reads with its original value. Record from the repo root with an authenticated `gh` (public data;
nothing in the output depends on who asks):

```bash
set -euo pipefail
O=seandavi
F=test/fixtures/github
REPOS="bioc-edge bioc-traffic bioc-infrastructure bioc-registry bioc-website bioc-build bioc-manifest bioc-intelligence bioc-mcp"
USER='(.user | if . then {login} else null end)'
ISSUES="[.[] | {number, title, html_url, created_at, updated_at, comments, labels: [.labels[] | {name}], user: $USER, draft}
         + (if .pull_request then {pull_request: {}} else {} end)]"
PULLS="[.[] | {number, title, html_url, created_at, updated_at, draft, user: $USER, head: {sha: .head.sha, ref: .head.ref}}]"
WORKFLOWS='{total_count, workflows: [.workflows[] | {id, name, path, state, html_url}]}'
RUNS='{total_count, workflow_runs: [.workflow_runs[] | {id, status, conclusion, event, created_at, html_url, display_title}]}'
rm -rf "$F" && mkdir -p "$F"
for r in $REPOS; do
  d=$F/$r
  mkdir -p "$d/pulls" "$d/actions/runs"
  gh api "repos/$O/$r" | jq '{default_branch}' > "$d/repo.json"
  branch=$(jq -r .default_branch "$d/repo.json")
  gh api "repos/$O/$r/issues?state=open&per_page=100&sort=created&direction=desc" | jq "$ISSUES" > "$d/issues.json"
  gh api "repos/$O/$r/pulls?state=open&per_page=100&sort=created&direction=desc" | jq "$PULLS" > "$d/pulls.json"
  for n in $(jq -r '.[].number' "$d/pulls.json"); do
    gh api "repos/$O/$r/pulls/$n" > /dev/null # the first read starts GitHub's mergeability check
    sleep 5
    gh api "repos/$O/$r/pulls/$n" | jq '{number, mergeable}' > "$d/pulls/$n.json"
  done
  for sha in $(jq -r '.[].head.sha' "$d/pulls.json"); do
    mkdir -p "$d/commits/$sha"
    gh api "repos/$O/$r/commits/$sha/check-runs?per_page=100" |
      jq '{total_count, check_runs: [.check_runs[] | {name, status, conclusion}]}' > "$d/commits/$sha/check-runs.json"
    gh api "repos/$O/$r/commits/$sha/status" | jq '{statuses: [.statuses[] | {context, state}]}' > "$d/commits/$sha/status.json"
  done
  gh api "repos/$O/$r/actions/workflows?per_page=100" | jq "$WORKFLOWS" > "$d/actions/workflows.json"
  for p in $(jq -r '.workflows[] | select(.state == "active" and (.path | startswith(".github/workflows/"))) | .path' "$d/actions/workflows.json"); do
    f=${p##*/}
    gh api "repos/$O/$r/actions/workflows/$f/runs?branch=$branch&per_page=20&exclude_pull_requests=true" | jq "$RUNS" > "$d/actions/runs/$f.json"
  done
done
date -u +%Y-%m-%dT%H:%M:%SZ > "$F/RECORDED_AT"
```

Run it once with `bash` from the repo root; it is not committed as a script. Check the result for
anything secret before committing (there is nothing: public issue metadata, run URLs, SHAs).

`test/support/github-routes.ts` exports:

```ts
export const GITHUB_RECORDED_AT: Date; // from test/fixtures/github/RECORDED_AT
export function githubUrl(repo: string, suffix?: string): string; // `https://api.github.com/repos/seandavi/${repo}${suffix ?? ''}`
export function githubRoutes(dir?: string): Record<string, FixtureRoute>; // dir defaults to test/fixtures/github; a fresh object each call, so tests can override entries
```

`githubRoutes` walks `test/fixtures/github/<repo>/` (`readdirSync(…, { recursive: true, withFileTypes: true })`) and maps
each file to its URL suffix:

| File under `<repo>/` | URL suffix |
|---|---|
| `repo.json` | `` (none) |
| `issues.json` | `/issues?state=open&per_page=100&sort=created&direction=desc` |
| `pulls.json` | `/pulls?state=open&per_page=100&sort=created&direction=desc` |
| `pulls/<n>.json` | `/pulls/<n>` |
| `commits/<sha>/check-runs.json` | `/commits/<sha>/check-runs?per_page=100` |
| `commits/<sha>/status.json` | `/commits/<sha>/status` |
| `actions/workflows.json` | `/actions/workflows?per_page=100` |
| `actions/runs/<file>.json` | `/actions/workflows/<file>/runs?branch=<default_branch from repo.json>&per_page=20&exclude_pull_requests=true` |

An unknown file throws (any non-directory entry that `suffixFor` does not map), so a stray fixture
fails loudly. Tests use `now = () => GITHUB_RECORDED_AT`.

Scenarios and the state observed on 2026-10-22. Tests assert against the recorded files. If a
scenario no longer holds when recorded, substitute a repo/workflow/PR that fits the criterion and
say so in the PR; scenarios GitHub cannot produce on demand are synthetic (inline routes overriding
`githubRoutes()`).

| Scenario | Where | Criterion | Observed 2026-10-22 |
|---|---|---|---|
| Failing workflow, no success in window | bioc-website `links.yml` | latest failure, 20 failures in the 20 runs | `fail`, streak 20, `last_success_at` null, reason `latest failure (20 in a row)` |
| Experimental failure | bioc-build `build.yml` | failing, repo experimental | `warn`, streak 2, `last_success_at` 2026-09-03T17:17:45Z |
| No runs on the default branch | bioc-website `preview-cleanup.yml`, bioc-build `build-package.yml`, bioc-mcp `docs-index.yml` | active, `workflow_runs` empty | `info`, reason `no completed runs on main`, `runs_examined` 0 |
| Repo with no workflows | bioc-traffic | `workflows: []` | all workflow counts 0 |
| Healthy workflow | bioc-registry `publish.yml` | latest success | `ok`, streak 0 |
| Disabled workflow | synthetic: bioc-manifest `actions/workflows.json` with `state: 'disabled_manually'` | — | `warn`, reason `workflow is disabled_manually`, no runs request |
| Cancelled latest run | synthetic runs page, latest `cancelled` | — | `warn` |
| PR with conflicts | bioc-website #74 | `mergeable: false` | `CONFLICTING`, `warn`, reason `merge conflicts` |
| Stale PR | bioc-website #14 | non-draft, updated > 14 days ago, mergeable | `info`, `no activity for N days` |
| PR mergeability pending | any PR whose detail has `mergeable: null` (bioc-edge #64 on 2026-10-22, may resolve on re-record) or synthetic | — | `UNKNOWN`, not a problem by itself |
| PR with failing checks | synthetic: a check run `timed_out` and a status `error` on bioc-website #74's head | — | `failing_checks` = `[<run name>, <context>]`, `failing_check_count` 2, `warn`, reason `2 failing checks; merge conflicts` |
| Failure issues | bioc-edge | open issues titled `<unit> is failing` | #69 `bioc-sync.service` (0 comments), #57 `bioc-rollup-minute.service` (97 comments) |
| Issue list cap | all repos | > 15 open issues | 114 open issues → 15 listed, 99 omitted |
| Truncated | synthetic: an issues page of 100 items | — | `truncated: true` |
| One repo fails | synthetic: bioc-traffic issues → 500 | — | bioc-traffic `error` set, other repos present, no bioc-traffic source |
| Every repo fails | synthetic: all routes 403 | — | `upstream_error` with the rate-limit message |

## Acceptance criteria

- [ ] `ops_activity` is registered in module `ops` with upstream `github`. `validateRegistry(modules)`
      passes on the production list `[metaModule, pkgModule, opsModule]`.
- [ ] `/mcp/ops` lists exactly `['ops_activity']`; `/mcp` lists exactly the meta, pkg and ops
      tools.
- [ ] For each kind, `GET /api/v1/ops/activity?kind=<kind>` (all repos) returns 200 and its body
      deep-equals the MCP `structuredContent` for the same input. No `kind` means `summary`.
- [ ] One fixture test per `kind` asserts the data, `sources` and key summary substrings, covering
      the scenario rows above.
- [ ] `repo=bioc-website&kind=workflows` lists all three workflows (`listed: 'all'`), with
      `links.yml` `fail` and `preview-cleanup.yml` `info`. Without `repo`, `listed` is
      `needs_attention` and only `fail`/`warn` workflows appear.
- [ ] `kind=prs` classifies bioc-website #74 `warn` (`merge conflicts`) and #14 `info`; the synthetic
      failing checks give `failing_checks` with the check run first, then the status context.
- [ ] `kind=failures` lists the `bioc-edge` units and its summary says nothing closes them on
      recovery. `kind=failures&repo=bioc-registry` is REST 400 `invalid_input` with no GitHub request.
- [ ] An unknown repo (`repo=bioc-nope`) or kind (`kind=all`) is REST 400 `invalid_input`, and
      `fetch.calls` is empty.
- [ ] Every success has one source per repo read, in config order: `https://api.github.com/repos/seandavi/<repo>`
      with `as_of` = the test clock (`GITHUB_RECORDED_AT`).
- [ ] A repo whose read fails (500, timeout or network error) appears with `error` set and no source;
      the other repos are intact and the summary names the failed repo. When every repo fails, the
      call fails: 403 everywhere gives `upstream_error` whose message mentions the rate limit (and
      `GITHUB_TOKEN` when no token is set); a single-repo timeout gives `upstream_timeout`.
- [ ] A 404 from GitHub gives `upstream_error`, never `not_found`.
- [ ] **Token:** with `GITHUB_TOKEN` set to a sentinel, every GitHub request carries
      `authorization: Bearer <sentinel>`, `accept: application/vnd.github+json` and
      `x-github-api-version: 2022-11-28`. Without it, there is no `authorization` header. Across
      every kind, the 401/403/404/500/timeout/network-error paths, REST bodies, MCP results, error
      messages and details, values written to the cache, and every `console.*` call, the sentinel
      never appears.
- [ ] `githubTokenWarning({})` returns the warning; `githubTokenWarning({ GITHUB_TOKEN: 'x' })`
      returns `undefined`; `githubTokenWarning({ GITHUB_TOKEN: '  ' })` returns the warning.
- [ ] Cache: two identical calls within 120 s request each GitHub URL once; after advancing the
      clock 121 s they are requested again. `summary`, `issues` and `failures` share the bioc-edge
      issues URL (one request for all three).
- [ ] Every kind's envelope on the full fixtures is under 8,192 bytes (`envelopeBytes`). The PR
      reports the figure for each kind.
- [ ] Rules tests reproduce bioc-health's `test_rules.py` cases for `actions_status`,
      `pr_checks_failing` and `pr_status`.
- [ ] `npm test` and `npm run typecheck` pass. `npm run build` succeeds.
- [ ] The PR states the plan assumption (Workers Paid) and the cold request counts, and asks #11 to
      confirm the plan before deploy.

## Test plan

All tests run in Node with `fixtureFetch(githubRoutes())`, `createMemoryCache`, and
`now = () => GITHUB_RECORDED_AT`. No network.

- `test/core/ops/rules.test.ts`:
  - `actionsStatus`: `('failure', false) → 'fail'`, `('failure', true) → 'warn'`,
    `('cancelled', false) → 'warn'`, `('success', false) → 'ok'`, `(null, false) → 'info'`,
    `('timed_out', false) → 'fail'`, `('skipped', false) → 'ok'`.
  - `prChecksFailing`: runs `[test: success, lint: timed_out]` and statuses
    `[ci/legacy: error, ci/ok: success]` → `['lint', 'ci/legacy']`; an in-progress run
    (`conclusion: null`) is not failing.
  - `prStatus`: `(0, 'CONFLICTING', 1, false) → warn`, `(1, 'MERGEABLE', 1, false) → warn '1 failing check'`,
    `(0, 'MERGEABLE', 15, false) → info 'no activity for 15 days'`, `(0, 'MERGEABLE', 15, true) → ok`,
    `(2, 'CONFLICTING', 1, false)` reason `'2 failing checks; merge conflicts'`.
  - `mergeableFrom`: `true`, `false`, `null`.
  - `summarizeRuns`: newest-first runs `[in_progress, failure, failure, success, failure]` →
    `latest_conclusion 'failure'`, streak 2, `last_success_at` = the success's `created_at`,
    `newest_run_at` = the in-progress run's; `[failure, cancelled, failure]` → streak 1; `[]` → all
    null, streak 0.
  - `ageDays`, `activitySince` (the 7-day boundary is inclusive by date), `truncateText`, `truncateTitle` (80 kept,
    81 → 79 + `…`), `FAILURE_ISSUE_TITLE` (matches `bioc-sync.service is failing` and a 64-character unit;
    not `bioc-sync is failing`, `Re: bioc-sync.service is failing`, a unit with a space or over 64
    characters).
- `test/upstreams/github.test.ts`: each fetcher's URL (exactly the table), schema stripping,
  `pathSegment` rejecting a `..` repo, 401 with a token → the replace-the-secret `upstream_error`,
  403/429 → rate-limit `upstream_error` (with and without a
  token in `deps.env`), 404 → `upstream_error`, an unexpected shape → `upstream_error` naming `what`,
  500 and timeout passed through, and `githubTokenWarning`.
- `test/core/ops/activity.test.ts`: one `describe` per kind through
  `invokeCapability(opsActivity, input, deps)`, covering the scenario rows; partial and total
  failure (including `failure_issues: null` when bioc-edge is unreadable); the `failures` + other
  `repo` rejection; failure issues from other accounts or with out-of-charset units ignored; 60
  maximum-length failure issues keep summary and failures under 8,192 bytes; caps and `omitted`;
  `envelopeBytes` per kind; the cache test.
- `test/core/ops/token.test.ts`: `deps.env = { GITHUB_TOKEN: SENTINEL }`; `deps.fetch` records each
  `Request` and its headers before delegating to `fixtureFetch`; a cache wrapper records every
  `put`; `vi.spyOn(console, …)` on `log`, `info`, `warn`, `error` and `debug`. Runs every kind, plus
  routes overridden to 401, 403, 404, 500, `'timeout'` and `'network-error'`, through REST and MCP
  (`makeTestApp({ env })`; the REST and MCP timeouts go through `makeTestApp({ fetch })`), and
  asserts the sentinel is absent from every serialized output, error and console argument, and
  present in every request's `authorization` header. A second case with `env: {}` asserts no
  `authorization` header.
- `test/transports/ops.test.ts`: `makeTestApp({ routes: githubRoutes(), extraModules: [opsModule], now })`;
  tools/list on `/mcp/ops`, and on `/mcp` built with `extraModules: [pkgModule, opsModule]`, asserting the
  exact meta, pkg and ops tool set (besides the `example_` tools), REST vs MCP equality per kind,
  REST 400 bodies, the MCP `isError` text for an all-repos 403 (`upstream_error: …`), and
  `/api/v1/about` listing `github` with `used_by: ['ops']`.
- `test/support/app.ts`: `makeTestApp` takes `env?: CapabilityEnv` (default `{}`), passed to `deps.env`, and `fetch?: FetchFn & { calls: string[] }` (replaces the
  `fixtureFetch` built from `routes`).

## Risks

- **Workers plan.** A cold all-repo `summary` makes about 49 GitHub requests and about 98 Cache API
  calls. On Workers Free (50 subrequests, 50 Cache API calls) it would run out: the cache wrapper
  turns failed Cache API calls into misses, and failed fetches become per-repo errors, so the result
  degrades to partial rather than crashing, but it would be mostly errors. The design assumes
  Workers Paid (inferred from bioc-infrastructure's docs, not verified for the bioc-mcp Worker). If
  the Worker must run on Free, `summary` and `workflows` across all repos need a different source
  (one repo-level runs call per repo, which **misses** rarely-run workflows: on 2026-10-22 the 50
  newest bioc-build runs held only `dispatch.yml`), and that is a new decision.
- **CPU and memory.** A cold all-repo summary parses about 6 MB of JSON (runs pages embed the
  repository object twice per run). Fine on Paid (30 s CPU by default, **Verified**); unmeasured in the Worker until
  #11. Warm calls parse the same bodies from the cache; there is no parse memo here (the pkg index
  memo exists because one body is 8 MB).
- **Rate limit.** 5,000 requests/h with the token. A cold summary is about 1% of that; the 2-minute
  cache is per data-centre, so heavy use from many locations multiplies it. Unauthenticated
  (dev only), 60/h runs out after one cold summary; the 403 message says so. Since #11 the Worker
  rate-limits each client address (IPv6 by /64) on `/mcp` and `/api`, and the Cache API is verified
  on the workers.dev hostname (spec #46).
- **Six connections.** Workers queue a fetch while six others are waiting for response headers
  (**Verified**, Cloudflare limits page). `fetchUpstream`'s 10 s
  timeout starts before the queue, so a slow GitHub could time out queued requests. At about
  300 ms per request, 49 requests take about 2.5 s; acceptable. Each timeout is a per-repo error.
- **Mergeability is lazy.** GitHub computes `mergeable` on first read, so a PR first seen within the
  cache window reads `UNKNOWN`. bioc-health has the same behaviour.
- **Truncation.** More than 100 open issues+PRs in one repo, more than 100 check runs on one
  commit, or a failure streak longer than 20 runs is not paged. The first two are flagged
  (`truncated`) or would undercount failing checks; the streak caps at 20, exactly as in bioc-health.
- **Drift from bioc-health.** The rules are copied, not shared (different languages, different
  repos). The header comment in `rules.ts` and the parity table above name the source commit.
  bioc-health's `repos` list does not include bioc-mcp; adding it there is a separate change in
  bioc-infrastructure.
- **Stale failure issues.** An open `<unit> is failing` issue does not mean the unit is failing
  now; only bioc-health's crossref, with live unit state, can tell. The tool says so in its
  description and summary instead of guessing.
- **Fixture drift.** Live state changes daily. The scenario table gives criteria so a re-recording
  can substitute workflows and PRs without changing code.
