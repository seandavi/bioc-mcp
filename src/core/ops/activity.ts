import * as z from 'zod';
import type { Envelope, Source } from '../../envelope';
import { CapabilityError } from '../../errors';
import {
  getCombinedStatus,
  getPull,
  getRepo,
  githubRepoApiUrl,
  listCheckRuns,
  listOpenIssues,
  listOpenPulls,
  listWorkflowRuns,
  listWorkflows,
  type GithubIssue,
  type GithubPull,
} from '../../upstreams/github';
import type { UpstreamResponse } from '../../upstreams/http';
import { defineCapability } from '../capability';
import type { Deps } from '../deps';
import {
  CHECK_NAME_LIMIT,
  EXPERIMENTAL_REPOS,
  FAILING_CHECK_LIMIT,
  FAILURE_ISSUE_REPO,
  FAILURE_ITEM_LIMIT,
  ISSUE_ITEM_LIMIT,
  OPS_KINDS,
  OPS_OWNER,
  OPS_REPOS,
  PR_ITEM_LIMIT,
  SUMMARY_PROBLEM_LIMIT,
  THRESHOLDS,
  WORKFLOW_ITEM_LIMIT,
  type OpsRepo,
} from './config';
import {
  activitySince,
  actionsStatus,
  ageDays,
  FAILED_CONCLUSIONS,
  FAILURE_ISSUE_TITLE,
  mergeableFrom,
  prChecksFailing,
  prStatus,
  summarizeRuns,
  truncateText,
  truncateTitle,
  type HealthStatus,
} from './rules';

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
  title: z.string().describe("At most 80 bytes of JSON text (80 ASCII characters, fewer otherwise), ending in '…' when cut"),
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
  title: z.string().describe("At most 80 bytes of JSON text (80 ASCII characters, fewer otherwise), ending in '…' when cut"),
  url: z.string(),
  draft: z.boolean(),
  age_days: z.number(),
  updated_age_days: z.number(),
  mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']).describe('UNKNOWN while GitHub computes it'),
  failing_checks: z
    .array(z.string())
    .describe(
      "Up to 3 failing check runs and commit statuses on the head commit (check runs first), each at most 40 bytes of JSON text (40 ASCII characters, fewer otherwise), ending in '…' when cut",
    ),
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
type WorkflowItem = z.output<typeof WorkflowItemSchema>;

const FailureItemSchema = z.object({
  unit: z.string().describe("systemd unit, e.g. 'bioc-sync.service'"),
  number: z.number().int(),
  url: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  comments: z.number().int().describe('Comments, one per repeat failure report plus any human ones'),
});
type FailureItem = z.output<typeof FailureItemSchema>;

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
  repo: z.literal(FAILURE_ISSUE_REPO),
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
type OpsActivityData = z.output<typeof OpsActivityDataSchema>;

const input = z.object({
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
});

const LIST_PAGE = 100; // per_page of the issue and PR lists: a full page means there may be more

// ---- per-repo isolation -------------------------------------------------------------------

type RepoOutcome<T> =
  | { repo: OpsRepo; ok: true; value: T; asOf: string } // asOf = the smallest fetchedAt tracked
  | { repo: OpsRepo; ok: false; error: CapabilityError };

/**
 * Runs `read` for each repo concurrently. A CapabilityError makes that repo's outcome `ok: false`
 * (one bad repo must not hide the others); anything else is a bug and propagates. With `prior`
 * (an earlier pass over the same repos), failed repos are not read again and `asOf` stays the
 * oldest of both passes.
 */
async function readRepos<T>(
  repos: readonly OpsRepo[],
  read: (repo: OpsRepo, track: (response: UpstreamResponse) => void) => Promise<T>,
  prior?: readonly RepoOutcome<unknown>[],
): Promise<RepoOutcome<T>[]> {
  return Promise.all(
    repos.map(async (repo): Promise<RepoOutcome<T>> => {
      const before = prior?.find((outcome) => outcome.repo === repo);
      if (before && !before.ok) return before;
      const fetchedAt: string[] = before?.ok ? [before.asOf] : [];
      try {
        const value = await read(repo, (response) => fetchedAt.push(response.fetchedAt));
        return { repo, ok: true, value, asOf: fetchedAt.reduce((a, b) => (b < a ? b : a)) };
      } catch (error) {
        if (error instanceof CapabilityError) return { repo, ok: false, error };
        throw error;
      }
    }),
  );
}

/** When no repo could be read the call fails with the first repo's own error. */
function assertSomeRead(outcomes: readonly RepoOutcome<unknown>[]): void {
  const firstFailure = outcomes.find((outcome) => !outcome.ok);
  if (firstFailure && !firstFailure.ok && outcomes.every((outcome) => !outcome.ok)) throw firstFailure.error;
}

function sourcesOf(outcomes: readonly RepoOutcome<unknown>[]): Source[] {
  return outcomes.flatMap((outcome) =>
    outcome.ok ? [{ url: githubRepoApiUrl(outcome.repo), as_of: outcome.asOf }] : [],
  );
}

function errorOf(outcome: RepoOutcome<unknown>): string | null {
  return outcome.ok ? null : outcome.error.message;
}

// ---- shared helpers -----------------------------------------------------------------------

interface Context {
  deps: Deps;
  repos: readonly OpsRepo[];
  repo: OpsRepo | undefined;
  now: Date;
  scope: string;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const moreSuffix = (count: number, shown: number) => (count > shown ? ` and ${count - shown} more` : '');
const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);

/** Newest first; ties by config order, then number descending. */
function newestFirst<T extends { repo: string; number: number; created_at: string }>(items: readonly T[]): T[] {
  const order = (repo: string) => OPS_REPOS.indexOf(repo as OpsRepo);
  return [...items].sort(
    (a, b) =>
      Date.parse(b.created_at) - Date.parse(a.created_at) || order(a.repo) - order(b.repo) || b.number - a.number,
  );
}

function errorsSentence(outcomes: readonly RepoOutcome<unknown>[]): string | undefined {
  const failed = outcomes.filter((outcome) => !outcome.ok);
  const first = failed[0];
  if (!first || first.ok) return undefined;
  return `Could not read ${failed.map((outcome) => outcome.repo).join(', ')}: ${first.error.message}`;
}

function joinSentences(sentences: readonly (string | undefined)[]): string {
  return sentences.filter((sentence) => sentence !== undefined).join(' ');
}

const issuesOnly = (items: readonly GithubIssue[]) => items.filter((item) => item.pull_request === undefined);
const isStale = (iso: string, now: Date, days: number) => ageDays(iso, now) > days;

// ---- issues -------------------------------------------------------------------------------

function issueStats(items: readonly GithubIssue[], now: Date) {
  const since = activitySince(now);
  return {
    stale: items.filter((item) => isStale(item.updated_at, now, THRESHOLDS.issueStaleDays)).length,
    new: items.filter((item) => item.created_at.slice(0, 10) >= since).length,
  };
}

function issueItem(repo: OpsRepo, issue: GithubIssue, now: Date): z.output<typeof IssueItemSchema> {
  return {
    repo,
    number: issue.number,
    title: truncateTitle(issue.title),
    url: issue.html_url,
    labels: issue.labels.map((label) => label.name),
    age_days: ageDays(issue.created_at, now),
    updated_age_days: ageDays(issue.updated_at, now),
    stale: isStale(issue.updated_at, now, THRESHOLDS.issueStaleDays),
    new: issue.created_at.slice(0, 10) >= activitySince(now),
  };
}

async function collectIssues(ctx: Context): Promise<Envelope<OpsActivityData>> {
  const { deps, repos, now } = ctx;
  const outcomes = await readRepos(repos, async (repo, track) => {
    const { response, data } = await listOpenIssues(deps, repo);
    track(response);
    return { truncated: data.length === LIST_PAGE, issues: issuesOnly(data) };
  });
  assertSomeRead(outcomes);

  const entries = outcomes.map((outcome) => {
    const issues = outcome.ok ? outcome.value.issues : [];
    return {
      repo: outcome.repo,
      error: errorOf(outcome),
      open: issues.length,
      ...issueStats(issues, now),
      truncated: outcome.ok && outcome.value.truncated,
    };
  });
  const all = outcomes.flatMap((outcome) =>
    outcome.ok
      ? outcome.value.issues.map((issue) => ({ ...issueItem(outcome.repo, issue, now), created_at: issue.created_at }))
      : [],
  );
  const listed = newestFirst(all)
    .slice(0, ISSUE_ITEM_LIMIT)
    .map(({ created_at: _createdAt, ...item }) => item);
  const omitted = all.length - listed.length;

  const open = sum(entries.map((entry) => entry.open));
  const stale = sum(entries.map((entry) => entry.stale));
  const fresh = sum(entries.map((entry) => entry.new));
  const summary = joinSentences([
    `${ctx.scope}: ${plural(open, 'open issue')}, ${stale} untouched over ${THRESHOLDS.issueStaleDays} days, ` +
      `${fresh} opened in the last ${THRESHOLDS.activityWindowDays} days.` +
      (listed.length > 0
        ? ` The ${listed.length} newest are listed` +
          (omitted > 0
            ? `; ${omitted} more are not${ctx.repo ? ` (see https://github.com/${OPS_OWNER}/${ctx.repo}/issues)` : ' (pass repo to narrow)'}`
            : '') +
          '.'
        : ''),
    errorsSentence(outcomes),
  ]);
  return { data: { kind: 'issues', repos: entries, items: listed, omitted }, summary, sources: sourcesOf(outcomes) };
}

// ---- pull requests ------------------------------------------------------------------------

async function collectPrs(ctx: Context): Promise<Envelope<OpsActivityData>> {
  const { deps, repos, now } = ctx;
  const listedOutcomes = await readRepos(repos, async (repo, track) => {
    const { response, data } = await listOpenPulls(deps, repo);
    track(response);
    return data;
  });

  type Candidate = { repo: OpsRepo; number: number; created_at: string; pull: GithubPull };
  const candidates: Candidate[] = listedOutcomes.flatMap((outcome) =>
    outcome.ok
      ? outcome.value.map((pull) => ({ repo: outcome.repo, number: pull.number, created_at: pull.created_at, pull }))
      : [],
  );
  const kept = newestFirst(candidates).slice(0, PR_ITEM_LIMIT);

  const checkedOutcomes = await readRepos(
    repos,
    async (repo, track) => {
      const mine = kept.filter((candidate) => candidate.repo === repo);
      return Promise.all(
        mine.map(async ({ pull }): Promise<z.output<typeof PrItemSchema> & { created_at: string }> => {
          const [detail, checks, status] = await Promise.all([
            getPull(deps, repo, pull.number),
            listCheckRuns(deps, repo, pull.head.sha),
            getCombinedStatus(deps, repo, pull.head.sha),
          ]);
          track(detail.response);
          track(checks.response);
          track(status.response);
          const failing = prChecksFailing(checks.data.check_runs, status.data.statuses);
          const mergeable = mergeableFrom(detail.data.mergeable);
          const updatedAge = ageDays(pull.updated_at, now);
          return {
            repo,
            number: pull.number,
            title: truncateTitle(pull.title),
            url: pull.html_url,
            draft: pull.draft,
            age_days: ageDays(pull.created_at, now),
            updated_age_days: updatedAge,
            mergeable,
            failing_checks: failing.slice(0, FAILING_CHECK_LIMIT).map((name) => truncateText(name, CHECK_NAME_LIMIT)),
            failing_check_count: failing.length,
            ...prStatus(failing.length, mergeable, updatedAge, pull.draft),
            created_at: pull.created_at,
          };
        }),
      );
    },
    listedOutcomes,
  );
  assertSomeRead(checkedOutcomes);

  const entries = checkedOutcomes.map((outcome) => {
    const listedOutcome = listedOutcomes.find((candidate) => candidate.repo === outcome.repo);
    const pulls = outcome.ok && listedOutcome?.ok ? listedOutcome.value : [];
    return {
      repo: outcome.repo,
      error: errorOf(outcome),
      open: pulls.length,
      draft: pulls.filter((pull) => pull.draft).length,
      stale: pulls.filter((pull) => !pull.draft && isStale(pull.updated_at, now, THRESHOLDS.prStaleDays)).length,
      truncated: pulls.length === LIST_PAGE,
    };
  });
  const items = newestFirst(checkedOutcomes.flatMap((outcome) => (outcome.ok ? outcome.value : []))).map(
    ({ created_at: _createdAt, ...item }) => item,
  );
  const open = sum(entries.map((entry) => entry.open));
  const omitted = open - items.length; // counted but never checked
  const needAttention = items.filter((item) => item.status === 'warn');
  const summary = joinSentences([
    `${ctx.scope}: ${plural(open, 'open PR')} (${sum(entries.map((entry) => entry.draft))} draft, ` +
      `${sum(entries.map((entry) => entry.stale))} non-draft untouched over ${THRESHOLDS.prStaleDays} days).` +
      (needAttention.length > 0
        ? ` Need attention: ${needAttention
            .slice(0, 5)
            .map((item) => `${item.repo}#${item.number} (${item.reason})`)
            .join('; ')}${moreSuffix(needAttention.length, 5)}.`
        : '') +
      (omitted > 0
        ? ` ${omitted} older PRs were not checked${ctx.repo ? ` (see https://github.com/${OPS_OWNER}/${ctx.repo}/pulls)` : '; pass repo to narrow'}.`
        : ''),
    errorsSentence(checkedOutcomes),
  ]);
  return { data: { kind: 'prs', repos: entries, items, omitted }, summary, sources: sourcesOf(checkedOutcomes) };
}

// ---- workflows ----------------------------------------------------------------------------

interface RepoWorkflows {
  defaultBranch: string;
  items: WorkflowItem[];
}

const WORKFLOW_DIR = '.github/workflows/';

/** (getRepo ∥ listWorkflows) → the newest default-branch runs of each active workflow. */
async function readWorkflows(
  deps: Deps,
  repo: OpsRepo,
  track: (response: UpstreamResponse) => void,
): Promise<RepoWorkflows> {
  const [repoRead, workflowsRead] = await Promise.all([getRepo(deps, repo), listWorkflows(deps, repo)]);
  track(repoRead.response);
  track(workflowsRead.response);
  const defaultBranch = repoRead.data.default_branch;
  const workflows = workflowsRead.data
    .filter((workflow) => workflow.path.startsWith(WORKFLOW_DIR))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const items = await Promise.all(
    workflows.map(async (workflow): Promise<WorkflowItem> => {
      const file = workflow.path.split('/').at(-1)!;
      if (workflow.state !== 'active') {
        return {
          repo,
          file,
          state: workflow.state,
          status: 'warn',
          reason: `workflow is ${workflow.state}`,
          latest_conclusion: null,
          latest_run_url: null,
          streak: 0,
          last_success_at: null,
          newest_run_at: null,
          runs_examined: 0,
        };
      }
      const runsRead = await listWorkflowRuns(deps, repo, file, defaultBranch, THRESHOLDS.runsPerWorkflow);
      track(runsRead.response);
      const runs = summarizeRuns(runsRead.data);
      const status = actionsStatus(runs.latest_conclusion, EXPERIMENTAL_REPOS.has(repo));
      const reason =
        runs.latest_conclusion === null
          ? `no completed runs on ${defaultBranch}`
          : `latest ${runs.latest_conclusion}` + (runs.streak > 1 ? ` (${runs.streak} in a row)` : '');
      return { repo, file, state: workflow.state, status, reason, ...runs };
    }),
  );
  return { defaultBranch, items };
}

function countByStatus(items: readonly { status: HealthStatus }[]) {
  const count = (status: HealthStatus) => items.filter((item) => item.status === status).length;
  return { ok: count('ok'), info: count('info'), warn: count('warn'), fail: count('fail') };
}

/** "Workflows needing attention: …" or the all-clear; fail first, then config order and path. */
function problemsSentence(items: readonly WorkflowItem[]): string {
  const problems = [
    ...items.filter((item) => item.status === 'fail'),
    ...items.filter((item) => item.status === 'warn'),
  ];
  if (problems.length === 0) return 'No default-branch workflow needs attention.';
  const described = problems.slice(0, SUMMARY_PROBLEM_LIMIT).map((item) => {
    const capped =
      EXPERIMENTAL_REPOS.has(item.repo as OpsRepo) &&
      item.latest_conclusion !== null &&
      FAILED_CONCLUSIONS.has(item.latest_conclusion);
    return `${item.repo}/${item.file} ${item.reason}${capped ? ' (experimental)' : ''}`;
  });
  return `Workflows needing attention: ${described.join('; ')}${moreSuffix(problems.length, SUMMARY_PROBLEM_LIMIT)}.`;
}

async function collectWorkflows(ctx: Context): Promise<Envelope<OpsActivityData>> {
  const { deps, repos } = ctx;
  const outcomes = await readRepos(repos, (repo, track) => readWorkflows(deps, repo, track));
  assertSomeRead(outcomes);

  const entries = outcomes.map((outcome) => ({
    repo: outcome.repo,
    error: errorOf(outcome),
    default_branch: outcome.ok ? outcome.value.defaultBranch : null,
    experimental: EXPERIMENTAL_REPOS.has(outcome.repo),
    ...countByStatus(outcome.ok ? outcome.value.items : []),
  }));
  const all = outcomes.flatMap((outcome) => (outcome.ok ? outcome.value.items : []));
  const listed = ctx.repo ? ('all' as const) : ('needs_attention' as const);
  const eligible = listed === 'all' ? all : all.filter((item) => item.status === 'fail' || item.status === 'warn');
  const workflows = eligible.slice(0, WORKFLOW_ITEM_LIMIT);

  const omitted = eligible.length - workflows.length;
  const totals = countByStatus(all);
  const summary = joinSentences([
    `${ctx.scope}: ${plural(all.length, 'default-branch workflow')}: ${totals.fail} failing, ${totals.warn} warn, ` +
      `${totals.info} with no completed run, ${totals.ok} ok.`,
    problemsSentence(all),
    omitted > 0 ? `Only the first ${WORKFLOW_ITEM_LIMIT} are listed; ${omitted} more are not.` : undefined,
    errorsSentence(outcomes),
  ]);
  return {
    data: { kind: 'workflows', listed, repos: entries, workflows, omitted },
    summary,
    sources: sourcesOf(outcomes),
  };
}

// ---- failures -----------------------------------------------------------------------------

/**
 * Open "<unit> is failing" issues opened by OPS_OWNER (the notifier posts as that account; anyone
 * else's issue is not a failure notice), newest first, first per unit (crossref.py `filed.setdefault`).
 */
function failureItems(issues: readonly GithubIssue[]): FailureItem[] {
  const units = new Map<string, FailureItem>();
  const candidates = issuesOnly(issues)
    .filter((issue) => issue.user?.login === OPS_OWNER)
    .map((issue) => ({ issue, unit: FAILURE_ISSUE_TITLE.exec(issue.title)?.[1] }))
    .sort((a, b) => Date.parse(b.issue.created_at) - Date.parse(a.issue.created_at) || b.issue.number - a.issue.number);
  for (const { issue, unit } of candidates) {
    if (unit === undefined || units.has(unit)) continue;
    units.set(unit, {
      unit,
      number: issue.number,
      url: issue.html_url,
      created_at: issue.created_at,
      updated_at: issue.updated_at,
      comments: issue.comments,
    });
  }
  return [...units.values()];
}

const failureCount = (count: number) => plural(count, `open "<unit> is failing" issue`);

/** Names at most FAILURE_ITEM_LIMIT units, so the summary text stays bounded however many issues are open. */
const unitList = (units: readonly FailureItem[]) =>
  units.slice(0, FAILURE_ITEM_LIMIT).map((item) => item.unit).join(', ') + moreSuffix(units.length, FAILURE_ITEM_LIMIT);

async function collectFailures(ctx: Context): Promise<Envelope<OpsActivityData>> {
  const outcomes = await readRepos([FAILURE_ISSUE_REPO], async (repo, track) => {
    const { response, data } = await listOpenIssues(ctx.deps, repo);
    track(response);
    return failureItems(data);
  });
  assertSomeRead(outcomes);
  const [outcome] = outcomes;
  const units = outcome?.ok ? outcome.value : [];
  const items = units.slice(0, FAILURE_ITEM_LIMIT);
  const summary =
    `${failureCount(units.length)} in ${FAILURE_ISSUE_REPO}` +
    (units.length > 0
      ? `: ${unitList(units)}. bioc-notify@ comments on the open issue at each failure ` +
        'and nothing closes it on recovery, so an open issue does not prove the unit is still failing.'
      : '.');
  return {
    data: { kind: 'failures', repo: FAILURE_ISSUE_REPO, items, omitted: units.length - items.length },
    summary,
    sources: sourcesOf(outcomes),
  };
}

// ---- summary ------------------------------------------------------------------------------

async function collectSummary(ctx: Context): Promise<Envelope<OpsActivityData>> {
  const { deps, repos, now } = ctx;
  const outcomes = await readRepos(repos, async (repo, track) => {
    const [issuesRead, workflows] = await Promise.all([
      listOpenIssues(deps, repo).then((read) => {
        track(read.response);
        return read.data;
      }),
      readWorkflows(deps, repo, track),
    ]);
    return { items: issuesRead, workflows: workflows.items };
  });
  assertSomeRead(outcomes);

  const entries = outcomes.map((outcome) => {
    const items = outcome.ok ? outcome.value.items : [];
    const workflows = outcome.ok ? outcome.value.workflows : [];
    const issues = issuesOnly(items);
    const pulls = items.filter((item) => item.pull_request !== undefined);
    const newest = items[0];
    return {
      repo: outcome.repo,
      error: errorOf(outcome),
      open_issues: issues.length,
      stale_issues: issueStats(issues, now).stale,
      new_issues: issueStats(issues, now).new,
      open_prs: pulls.length,
      draft_prs: pulls.filter((pull) => pull.draft === true).length,
      stale_prs: pulls.filter((pull) => pull.draft !== true && isStale(pull.updated_at, now, THRESHOLDS.prStaleDays))
        .length,
      truncated: items.length === LIST_PAGE,
      newest: newest
        ? {
            kind: newest.pull_request === undefined ? ('issue' as const) : ('pr' as const),
            number: newest.number,
            title: truncateTitle(newest.title),
            url: newest.html_url,
            created_at: newest.created_at,
          }
        : null,
      workflows: {
        total: workflows.length,
        ...countByStatus(workflows),
        needs_attention: workflows
          .filter((item) => item.status === 'fail' || item.status === 'warn')
          .map((item) => item.file),
      },
      failure_issues: outcome.repo === FAILURE_ISSUE_REPO && outcome.ok ? failureItems(items).length : null,
    };
  });

  const edge = outcomes.find((outcome) => outcome.repo === FAILURE_ISSUE_REPO);
  const edgeUnits = edge?.ok ? failureItems(edge.value.items) : undefined;
  const summary = joinSentences([
    `${ctx.scope}: ${plural(sum(entries.map((entry) => entry.open_issues)), 'open issue')} ` +
      `(${sum(entries.map((entry) => entry.stale_issues))} untouched over ${THRESHOLDS.issueStaleDays} days, ` +
      `${sum(entries.map((entry) => entry.new_issues))} opened in the last ${THRESHOLDS.activityWindowDays} days) ` +
      `and ${plural(sum(entries.map((entry) => entry.open_prs)), 'open PR')} ` +
      `(${sum(entries.map((entry) => entry.stale_prs))} non-draft untouched over ${THRESHOLDS.prStaleDays} days).`,
    problemsSentence(outcomes.flatMap((outcome) => (outcome.ok ? outcome.value.workflows : []))),
    edgeUnits
      ? `${failureCount(edgeUnits.length)} in ${FAILURE_ISSUE_REPO}` +
        (edgeUnits.length > 0
          ? ` (${unitList(edgeUnits)}); nothing closes them when a unit recovers, so check before acting.`
          : '.')
      : undefined,
    errorsSentence(outcomes),
  ]);
  return { data: { kind: 'summary', repos: entries }, summary, sources: sourcesOf(outcomes) };
}

// ---- capability ---------------------------------------------------------------------------

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
    'propagation state use pkg_status. Does not report host, service or traffic health. ' +
    'For why or how the infrastructure works this way (design, ADRs, runbooks) use docs_search.',
  input,
  data: OpsActivityDataSchema,
  async handler({ repo, kind }, deps) {
    if (kind === 'failures' && repo !== undefined && repo !== FAILURE_ISSUE_REPO) {
      throw new CapabilityError(
        'invalid_input',
        `"<unit> is failing" issues are filed only in ${FAILURE_ISSUE_REPO}; omit repo or pass repo=${FAILURE_ISSUE_REPO}.`,
      );
    }
    const repos: OpsRepo[] = repo ? [repo] : [...OPS_REPOS];
    const context: Context = {
      deps,
      repos,
      repo,
      now: deps.now(),
      scope: repo ?? `${repos.length} repos`,
    };
    switch (kind) {
      case 'summary':
        return collectSummary(context);
      case 'issues':
        return collectIssues(context);
      case 'prs':
        return collectPrs(context);
      case 'workflows':
        return collectWorkflows(context);
      case 'failures':
        return collectFailures(context);
    }
  },
});
