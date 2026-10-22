import * as z from 'zod';
import { THRESHOLDS } from '../core/ops/config';
import type { CapabilityEnv, Deps } from '../core/deps';
import { CapabilityError } from '../errors';
import { fetchUpstreamJson, pathSegment, type Upstream, type UpstreamResponse } from './http';

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
export function githubRepoApiUrl(repo: string): string {
  return new URL(pathSegment(repo), GITHUB_BASE_URL).href;
}

/** The start-up warning when no token is configured; undefined when one is. */
export function githubTokenWarning(env: CapabilityEnv): string | undefined {
  if (env.GITHUB_TOKEN?.trim()) return undefined;
  return (
    'GITHUB_TOKEN is not set: GitHub requests are unauthenticated and limited to 60 per hour per IP. ' +
    'Set it with `wrangler secret put GITHUB_TOKEN` (or in .dev.vars for wrangler dev).'
  );
}

/** Adds the GitHub headers, and the token when there is one. Nothing else reads the token. */
function githubDeps(deps: Deps): Deps {
  const token = deps.env.GITHUB_TOKEN?.trim();
  return {
    ...deps,
    fetch: (request) => {
      const headers = new Headers(request.headers);
      headers.set('accept', 'application/vnd.github+json');
      headers.set('x-github-api-version', '2022-11-28');
      if (token) headers.set('authorization', `Bearer ${token}`);
      return deps.fetch(new Request(request, { headers }));
    },
  };
}

const UserSchema = z.object({ login: z.string() }).nullable(); // null for deleted users

export const GithubRepoSchema = z.object({ default_branch: z.string() });
export type GithubRepo = z.infer<typeof GithubRepoSchema>;

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
export type GithubPullDetail = z.infer<typeof GithubPullDetailSchema>;

export const GithubCheckRunsSchema = z.object({
  total_count: z.number().int(),
  check_runs: z.array(z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable() })),
});
export type GithubCheckRuns = z.infer<typeof GithubCheckRunsSchema>;

export const GithubCombinedStatusSchema = z.object({
  statuses: z.array(z.object({ context: z.string(), state: z.string() })),
});
export type GithubCombinedStatus = z.infer<typeof GithubCombinedStatusSchema>;

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

const WorkflowListSchema = z.object({ workflows: z.array(GithubWorkflowSchema) });
const WorkflowRunListSchema = z.object({ workflow_runs: z.array(GithubWorkflowRunSchema) });

interface Fetched<T> {
  response: UpstreamResponse;
  data: T;
}

/** GET + validate; maps GitHub's refusals and 404s to upstream_error (a 404 is never the caller's mistake). */
async function githubJson<S extends z.ZodType>(
  deps: Deps,
  repo: string,
  path: string,
  schema: S,
  what: string,
): Promise<Fetched<z.output<S>>> {
  let fetched: Awaited<ReturnType<typeof fetchUpstreamJson>>;
  try {
    fetched = await fetchUpstreamJson(githubDeps(deps), githubUpstream, path);
  } catch (error) {
    if (!(error instanceof CapabilityError)) throw error;
    const { status } = error.details;
    if (status === 403 || status === 429) {
      const tokenless = deps.env.GITHUB_TOKEN?.trim() ? '' : '; this server has no GITHUB_TOKEN, so the limit is 60 requests per hour';
      throw new CapabilityError(
        'upstream_error',
        `GitHub refused the request (HTTP ${status}), most likely its rate limit${tokenless}. Try again later.`,
        error.details,
      );
    }
    if (error.code === 'not_found') {
      throw new CapabilityError(
        'upstream_error',
        `GitHub has nothing at ${error.details.url}; the repository may have been renamed or made private`,
        error.details,
      );
    }
    throw error;
  }
  const { response, json } = fetched;
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new CapabilityError('upstream_error', `GitHub returned an unexpected ${what} for seandavi/${repo}`, {
      upstream: githubUpstream.id,
      url: response.url,
    });
  }
  return { response, data: parsed.data };
}

export async function getRepo(deps: Deps, repo: string): Promise<Fetched<GithubRepo>> {
  return githubJson(deps, repo, pathSegment(repo), GithubRepoSchema, 'repository');
}

/** Open issues and PRs together, newest first. */
export async function listOpenIssues(deps: Deps, repo: string): Promise<Fetched<GithubIssue[]>> {
  const path = `${pathSegment(repo)}/issues?state=open&per_page=100&sort=created&direction=desc`;
  return githubJson(deps, repo, path, z.array(GithubIssueSchema), 'issue list');
}

export async function listOpenPulls(deps: Deps, repo: string): Promise<Fetched<GithubPull[]>> {
  const path = `${pathSegment(repo)}/pulls?state=open&per_page=100&sort=created&direction=desc`;
  return githubJson(deps, repo, path, z.array(GithubPullSchema), 'pull request list');
}

export async function getPull(deps: Deps, repo: string, number: number): Promise<Fetched<GithubPullDetail>> {
  const path = `${pathSegment(repo)}/pulls/${pathSegment(String(number))}`;
  return githubJson(deps, repo, path, GithubPullDetailSchema, 'pull request');
}

export async function listCheckRuns(deps: Deps, repo: string, sha: string): Promise<Fetched<GithubCheckRuns>> {
  const path = `${pathSegment(repo)}/commits/${pathSegment(sha)}/check-runs?per_page=100`;
  return githubJson(deps, repo, path, GithubCheckRunsSchema, 'check run list');
}

export async function getCombinedStatus(deps: Deps, repo: string, sha: string): Promise<Fetched<GithubCombinedStatus>> {
  const path = `${pathSegment(repo)}/commits/${pathSegment(sha)}/status`;
  return githubJson(deps, repo, path, GithubCombinedStatusSchema, 'commit status');
}

export async function listWorkflows(deps: Deps, repo: string): Promise<Fetched<GithubWorkflow[]>> {
  const path = `${pathSegment(repo)}/actions/workflows?per_page=100`;
  const { response, data } = await githubJson(deps, repo, path, WorkflowListSchema, 'workflow list');
  return { response, data: data.workflows };
}

export async function listWorkflowRuns(
  deps: Deps,
  repo: string,
  file: string,
  branch: string,
): Promise<Fetched<GithubWorkflowRun[]>> {
  const path =
    `${pathSegment(repo)}/actions/workflows/${pathSegment(file)}/runs` +
    `?branch=${encodeURIComponent(branch)}&per_page=${THRESHOLDS.runsPerWorkflow}&exclude_pull_requests=true`;
  const { response, data } = await githubJson(deps, repo, path, WorkflowRunListSchema, 'workflow run list');
  return { response, data: data.workflow_runs };
}
