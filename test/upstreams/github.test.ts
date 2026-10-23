import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { Deps } from '../../src/core/deps';
import { CapabilityError } from '../../src/errors';
import { createMemoryCache } from '../../src/upstreams/cache';
import {
  getBranch,
  getCombinedStatus,
  getPull,
  getRepo,
  githubRepoApiUrl,
  githubTokenWarning,
  listCheckRuns,
  listDeploymentStatuses,
  listDeployments,
  listOpenIssues,
  listOpenPulls,
  listWorkflowRuns,
  listWorkflows,
} from '../../src/upstreams/github';
import { fixtureFetch, type FixtureRoute } from '../support/fixture-fetch';
import { GITHUB_RECORDED_AT, githubRoutes, githubUrl } from '../support/github-routes';

function makeDeps(routes: Record<string, FixtureRoute> = githubRoutes(), env: Deps['env'] = {}) {
  const now = () => GITHUB_RECORDED_AT;
  const fetch = fixtureFetch(routes);
  return { deps: { fetch, cache: createMemoryCache(now), now, env } satisfies Deps, fetch };
}

async function errorOf(promise: Promise<unknown>): Promise<CapabilityError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CapabilityError);
    return error as CapabilityError;
  }
  throw new Error('expected a CapabilityError');
}

describe('fetchers request exactly the documented URLs', () => {
  test('repo', async () => {
    const { deps, fetch } = makeDeps();
    expect((await getRepo(deps, 'bioc-website')).data).toEqual({ default_branch: 'main' });
    expect(fetch.calls).toEqual([githubUrl('bioc-website')]);
  });

  test('issues and pulls', async () => {
    const { deps, fetch } = makeDeps();
    const issues = await listOpenIssues(deps, 'bioc-edge');
    expect(issues.data.length).toBeGreaterThan(0);
    await listOpenPulls(deps, 'bioc-website');
    expect(fetch.calls).toEqual([
      githubUrl('bioc-edge', '/issues?state=open&per_page=100&sort=created&direction=desc'),
      githubUrl('bioc-website', '/pulls?state=open&per_page=100&sort=created&direction=desc'),
    ]);
  });

  test('a PR, its check runs and its combined status', async () => {
    const { deps, fetch } = makeDeps();
    const pull = (await listOpenPulls(deps, 'bioc-website')).data.find((p) => p.number === 74)!;
    await getPull(deps, 'bioc-website', 74);
    await listCheckRuns(deps, 'bioc-website', pull.head.sha);
    await getCombinedStatus(deps, 'bioc-website', pull.head.sha);
    expect(fetch.calls.slice(1)).toEqual([
      githubUrl('bioc-website', '/pulls/74'),
      githubUrl('bioc-website', `/commits/${pull.head.sha}/check-runs?per_page=100`),
      githubUrl('bioc-website', `/commits/${pull.head.sha}/status`),
    ]);
  });

  test('workflows and runs', async () => {
    const { deps, fetch } = makeDeps();
    const workflows = await listWorkflows(deps, 'bioc-website');
    expect(workflows.data.map((w) => w.path)).toContain('.github/workflows/links.yml');
    const runs = await listWorkflowRuns(deps, 'bioc-website', 'links.yml', 'main', 20);
    expect(runs.data).toHaveLength(20);
    expect(fetch.calls).toEqual([
      githubUrl('bioc-website', '/actions/workflows?per_page=100'),
      githubUrl('bioc-website', '/actions/workflows/links.yml/runs?branch=main&per_page=20&exclude_pull_requests=true'),
    ]);
  });
});

describe('branch and deployment fetchers', () => {
  const docs = 'docs/api.github.com/repos/seandavi/bioc-infrastructure';
  const deploymentsUrl = githubUrl('bioc-infrastructure', '/deployments?environment=github-pages&per_page=10');
  const statusesUrl = githubUrl('bioc-infrastructure', '/deployments/7131578958/statuses?per_page=1');
  const branchUrl = githubUrl('bioc-infrastructure', '/branches/main');
  const routes: Record<string, FixtureRoute> = {
    [branchUrl]: { file: `${docs}/branches/main` },
    [deploymentsUrl]: { file: `${docs}/deployments/%3Fenvironment%3Dgithub-pages%26per_page%3D10` },
    [statusesUrl]: { file: `${docs}/deployments/7131578958/statuses/%3Fper_page%3D1` },
  };

  test('request the documented URLs and parse the recorded responses', async () => {
    const { deps, fetch } = makeDeps(routes);
    const branch = await getBranch(deps, 'bioc-infrastructure', 'main');
    expect(branch.data.commit.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(branch.data.commit.commit.committer.date).toMatch(/^\d{4}-\d\d-\d\dT/);
    const deployments = await listDeployments(deps, 'bioc-infrastructure', 'github-pages', 10);
    expect(deployments.data).toHaveLength(10);
    expect(deployments.data[0]).toMatchObject({ id: 7131578958, ref: 'main' });
    const statuses = await listDeploymentStatuses(deps, 'bioc-infrastructure', 7131578958, 1);
    expect(statuses.data).toEqual([{ state: 'success' }]);
    expect(fetch.calls).toEqual([branchUrl, deploymentsUrl, statusesUrl]);
  });

  test('send the GitHub headers and the token', async () => {
    const seen: Headers[] = [];
    const inner = fixtureFetch(routes);
    const { deps } = makeDeps(routes, { GITHUB_TOKEN: 'sentinel' });
    await getBranch({ ...deps, fetch: (request) => (seen.push(request.headers), inner(request)) }, 'bioc-infrastructure', 'main');
    expect(seen[0]!.get('accept')).toBe('application/vnd.github+json');
    expect(seen[0]!.get('authorization')).toBe('Bearer sentinel');
  });

  test('reject a "/" in a branch name before any request', async () => {
    const { deps, fetch } = makeDeps(routes);
    expect((await errorOf(getBranch(deps, 'bioc-infrastructure', 'feature/x'))).code).toBe('invalid_input');
    expect(fetch.calls).toEqual([]);
  });

  test.each([
    ['branch', () => branchUrl, (d: Deps) => getBranch(d, 'bioc-infrastructure', 'main')],
    ['deployment list', () => deploymentsUrl, (d: Deps) => listDeployments(d, 'bioc-infrastructure', 'github-pages', 10)],
    ['deployment status list', () => statusesUrl, (d: Deps) => listDeploymentStatuses(d, 'bioc-infrastructure', 7131578958, 1)],
  ])('name the %s when the shape is wrong', async (what, url, call) => {
    const { deps } = makeDeps({ [url()]: { status: 200, body: '{"nope":1}' } });
    expect((await errorOf(call(deps))).message).toBe(`GitHub returned an unexpected ${what} for seandavi/bioc-infrastructure.`);
  });

  test('a branch with a short sha is an unexpected shape', async () => {
    const body = JSON.stringify({ name: 'main', commit: { sha: 'abc', commit: { committer: { date: '2026-10-16T23:21:08Z' } } } });
    const { deps } = makeDeps({ [branchUrl]: { status: 200, body } });
    expect((await errorOf(getBranch(deps, 'bioc-infrastructure', 'main'))).message).toContain('unexpected branch');
  });
});

describe('schemas', () => {
  test('strip fields they do not read', async () => {
    const { deps } = makeDeps({
      [githubUrl('bioc-website')]: { status: 200, body: JSON.stringify({ default_branch: 'main', private: false, id: 1 }) },
    });
    expect((await getRepo(deps, 'bioc-website')).data).toStrictEqual({ default_branch: 'main' });
  });

  test('a deleted user (null) and a PR item parse', async () => {
    const { deps } = makeDeps();
    const items = (await listOpenIssues(deps, 'bioc-edge')).data;
    const pr = items.find((item) => item.pull_request !== undefined);
    expect(pr?.number).toBe(64);
    expect(items.some((item) => item.pull_request === undefined)).toBe(true);
  });
});

describe('inputs', () => {
  test('pathSegment rejects a ".." repo before any request', async () => {
    const { deps, fetch } = makeDeps();
    expect((await errorOf(getRepo(deps, '..'))).code).toBe('invalid_input');
    expect(fetch.calls).toEqual([]);
  });

  test('githubRepoApiUrl is the repo URL', () => {
    expect(githubRepoApiUrl('bioc-mcp')).toBe('https://api.github.com/repos/seandavi/bioc-mcp');
  });
});

describe('errors', () => {
  const url = githubUrl('bioc-website');

  test.each([403, 429])('HTTP %s is the rate-limit upstream_error, mentioning the missing token', async (status) => {
    const { deps } = makeDeps({ [url]: { status } });
    const error = await errorOf(getRepo(deps, 'bioc-website'));
    expect(error.code).toBe('upstream_error');
    expect(error.message).toContain(`HTTP ${status}`);
    expect(error.message).toContain('rate limit');
    expect(error.message).toContain('no GITHUB_TOKEN');
    expect(error.details.status).toBe(status);
  });

  test('HTTP 401 with a token says the operator must replace the secret, without leaking it', async () => {
    const { deps } = makeDeps({ [url]: { status: 401 } }, { GITHUB_TOKEN: 'sentinel' });
    const error = await errorOf(getRepo(deps, 'bioc-website'));
    expect(error.code).toBe('upstream_error');
    expect(error.message).toBe(
      "GitHub rejected this server's GITHUB_TOKEN (HTTP 401); the operator must replace the secret. Try again later.",
    );
    expect(error.details.status).toBe(401);
    expect(JSON.stringify([error.message, error.details])).not.toContain('sentinel');
  });

  test('HTTP 401 without a token is a plain upstream_error that does not blame GITHUB_TOKEN', async () => {
    const { deps } = makeDeps({ [url]: { status: 401 } });
    const error = await errorOf(getRepo(deps, 'bioc-website'));
    expect(error.code).toBe('upstream_error');
    expect(error.message).not.toContain('GITHUB_TOKEN');
  });

  test('with a token the rate-limit message does not blame its absence', async () => {
    const { deps } = makeDeps({ [url]: { status: 403 } }, { GITHUB_TOKEN: 'sentinel' });
    const error = await errorOf(getRepo(deps, 'bioc-website'));
    expect(error.message).toContain('rate limit');
    expect(error.message).not.toContain('GITHUB_TOKEN');
    expect(error.message).not.toContain('sentinel');
  });

  test('a 404 is upstream_error, never not_found', async () => {
    const { deps } = makeDeps({ [url]: { status: 404, body: '{}' } });
    const error = await errorOf(getRepo(deps, 'bioc-website'));
    expect(error.code).toBe('upstream_error');
    expect(error.message).toBe(
      `GitHub has nothing at ${url}; the repository, PR or workflow may have been removed, renamed or made private.`,
    );
  });

  test('an unexpected shape names what was read', async () => {
    const { deps } = makeDeps({ [url]: { status: 200, body: '{"nope":1}' } });
    const error = await errorOf(getRepo(deps, 'bioc-website'));
    expect(error.code).toBe('upstream_error');
    expect(error.message).toBe('GitHub returned an unexpected repository for seandavi/bioc-website.');
  });

  test.each([
    ['issue list', (d: Deps) => listOpenIssues(d, 'bioc-website'), '/issues?state=open&per_page=100&sort=created&direction=desc'],
    ['workflow list', (d: Deps) => listWorkflows(d, 'bioc-website'), '/actions/workflows?per_page=100'],
    ['pull request', (d: Deps) => getPull(d, 'bioc-website', 74), '/pulls/74'],
  ])('names the %s', async (what, call, suffix) => {
    const { deps } = makeDeps({ [githubUrl('bioc-website', suffix)]: { status: 200, body: '{"nope":1}' } });
    expect((await errorOf(call(deps))).message).toBe(`GitHub returned an unexpected ${what} for seandavi/bioc-website.`);
  });

  test('500 and timeout pass through with their own codes', async () => {
    expect((await errorOf(getRepo(makeDeps({ [url]: { status: 500 } }).deps, 'bioc-website'))).code).toBe('upstream_error');
    const timedOut = { ...makeDeps().deps, fetch: () => Promise.reject(new DOMException('timed out', 'TimeoutError')) };
    expect((await errorOf(getRepo(timedOut, 'bioc-website'))).code).toBe('upstream_timeout');
  });

  test('a network error is upstream_error', async () => {
    const { deps } = makeDeps({ [url]: 'network-error' });
    expect((await errorOf(getRepo(deps, 'bioc-website'))).code).toBe('upstream_error');
  });
});

describe('githubTokenWarning', () => {
  test('warns without a token and never includes one', () => {
    for (const env of [{}, { GITHUB_TOKEN: '  ' }, { GITHUB_TOKEN: undefined }]) {
      expect(githubTokenWarning(env)).toBe(
        'GITHUB_TOKEN is not set: GitHub requests are unauthenticated and limited to 60 per hour per IP. Set it with `wrangler secret put GITHUB_TOKEN` (or in .dev.vars for wrangler dev).',
      );
    }
  });

  test('is undefined with a token', () => {
    expect(githubTokenWarning({ GITHUB_TOKEN: 'x' })).toBeUndefined();
  });
});

describe('githubRoutes', () => {
  test('throws on a file it cannot map', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gh-routes-'));
    try {
      mkdirSync(join(dir, 'bioc-x'));
      writeFileSync(join(dir, 'bioc-x', 'repo.json'), '{"default_branch":"main"}');
      writeFileSync(join(dir, 'bioc-x', 'notes.txt'), 'stray');
      expect(() => githubRoutes(dir)).toThrow('Unknown GitHub fixture: bioc-x/notes.txt');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('maps every recorded file', () => {
    const root = join(import.meta.dirname, '..', 'fixtures', 'github');
    const files = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((repo) =>
        readdirSync(join(root, repo.name), { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()),
      );
    expect(Object.keys(githubRoutes())).toHaveLength(files.length);
  });
});
