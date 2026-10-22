import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import type * as z from 'zod';
import type { Deps } from '../../../src/core/deps';
import { invokeCapability } from '../../../src/core/invoke';
import { OpsActivityDataSchema, opsActivity } from '../../../src/core/ops/activity';
import { OPS_REPOS } from '../../../src/core/ops/config';
import { envelopeBytes, MAX_RESULT_BYTES, type Envelope } from '../../../src/envelope';
import { createMemoryCache } from '../../../src/upstreams/cache';
import { fixtureFetch, type FixtureRoute } from '../../support/fixture-fetch';
import { GITHUB_RECORDED_AT, githubRoutes, githubUrl } from '../../support/github-routes';
import { testContext } from '../../support/invoke-context';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'github');

type Data = z.output<typeof OpsActivityDataSchema>;
type Kind = Data['kind'];
type Of<K extends Kind> = Extract<Data, { kind: K }>;

const KINDS: Kind[] = ['summary', 'issues', 'prs', 'workflows', 'failures'];
const ISSUES_SUFFIX = '/issues?state=open&per_page=100&sort=created&direction=desc';
const PULLS_SUFFIX = '/pulls?state=open&per_page=100&sort=created&direction=desc';
const RECORDED_AT_ISO = GITHUB_RECORDED_AT.toISOString();

function fixtureJson(path: string): any {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, path), 'utf8'));
}

function makeDeps(routes: Record<string, FixtureRoute> = githubRoutes(), now: () => Date = () => GITHUB_RECORDED_AT) {
  const fetch = fixtureFetch(routes);
  const deps: Deps = { fetch, cache: createMemoryCache(now), now, env: {} };
  return { deps, fetch };
}

async function run<K extends Kind>(kind: K, extra: { repo?: string } = {}, routes = githubRoutes()) {
  const { deps, fetch } = makeDeps(routes);
  const result = await invokeCapability(opsActivity, { kind, ...extra }, deps, testContext());
  if (!result.ok) throw result.error;
  const envelope = result.envelope as Envelope<Of<K>>;
  return { envelope, data: envelope.data, summary: envelope.summary, sources: envelope.sources, fetch };
}

async function failure(input: Record<string, unknown>, routes = githubRoutes(), deps = makeDeps(routes).deps) {
  const result = await invokeCapability(opsActivity, input, deps, testContext());
  if (result.ok) throw new Error('expected a failure');
  return result.error;
}

const repoSources = (repos: readonly string[]) =>
  repos.map((repo) => ({ url: githubUrl(repo), as_of: RECORDED_AT_ISO }));

describe('summary', () => {
  test('counts per repo, workflows needing attention and failure issues', async () => {
    const { data, summary, sources } = await run('summary');
    expect(data.repos.map((r) => r.repo)).toEqual([...OPS_REPOS]);
    expect(data.repos.every((r) => r.error === null)).toBe(true);
    expect(sources).toEqual(repoSources(OPS_REPOS));

    const website = data.repos.find((r) => r.repo === 'bioc-website')!;
    expect(website).toMatchObject({ open_prs: 2, draft_prs: 0, stale_prs: 1, truncated: false });
    expect(website.workflows).toEqual({ total: 3, ok: 1, info: 1, warn: 0, fail: 1, needs_attention: ['links.yml'] });
    expect(website.newest?.kind).toBe(fixtureJson('bioc-website/issues.json')[0].pull_request ? 'pr' : 'issue');

    const build = data.repos.find((r) => r.repo === 'bioc-build')!;
    expect(build.workflows).toMatchObject({ total: 3, warn: 1, info: 1, ok: 1, needs_attention: ['build.yml'] });

    const traffic = data.repos.find((r) => r.repo === 'bioc-traffic')!;
    expect(traffic.workflows).toEqual({ total: 0, ok: 0, info: 0, warn: 0, fail: 0, needs_attention: [] });
    expect(traffic.failure_issues).toBeNull();

    const edge = data.repos.find((r) => r.repo === 'bioc-edge')!;
    expect(edge.failure_issues).toBe(2);
    expect(data.repos.filter((r) => r.failure_issues !== null).map((r) => r.repo)).toEqual(['bioc-edge']);

    expect(summary).toContain('9 repos:');
    expect(summary).toContain('Workflows needing attention: bioc-website/links.yml latest failure (20 in a row);');
    expect(summary).toContain('bioc-build/build.yml latest failure (2 in a row) (experimental)');
    expect(summary).toContain('2 open "<unit> is failing" issues in bioc-edge (bioc-sync.service, bioc-rollup-minute.service)');
    expect(summary).toContain('nothing closes them when a unit recovers, so check before acting.');
  });

  test('with repo, only that repo is read and the scope is its name', async () => {
    const { data, summary, fetch } = await run('summary', { repo: 'bioc-registry' });
    expect(data.repos.map((r) => r.repo)).toEqual(['bioc-registry']);
    expect(summary.startsWith('bioc-registry:')).toBe(true);
    expect(summary).not.toContain('is failing');
    expect(summary).toContain('No default-branch workflow needs attention.');
    expect(fetch.calls.every((url) => url.startsWith(githubUrl('bioc-registry')))).toBe(true);
  });

  test('a repo with 100 issues and PRs is truncated', async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({
      number: 1000 - i,
      title: `issue ${i}`,
      html_url: 'https://github.com/seandavi/bioc-mcp/issues/1',
      created_at: '2026-10-21T00:00:00Z',
      updated_at: '2026-10-21T00:00:00Z',
      comments: 0,
      labels: [],
      user: null,
    }));
    const routes = { ...githubRoutes(), [githubUrl('bioc-mcp', ISSUES_SUFFIX)]: { status: 200, body: JSON.stringify(page) } };
    const { data } = await run('summary', { repo: 'bioc-mcp' }, routes);
    expect(data.repos[0]).toMatchObject({ open_issues: 100, new_issues: 100, stale_issues: 0, truncated: true });
  });
});

describe('issues', () => {
  test('lists the 15 newest open issues across all repos, newest first', async () => {
    const { data, summary, sources } = await run('issues');
    expect(data.items).toHaveLength(15);
    expect(data.omitted).toBe(data.repos.reduce((n, r) => n + r.open, 0) - 15);
    expect(data.omitted).toBeGreaterThan(0);
    const times = data.items.map((item) => Date.parse(fixtureCreatedAt(item.repo, item.number)));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(data.items.every((item) => item.title.length <= 80)).toBe(true);
    expect(sources).toEqual(repoSources(OPS_REPOS));
    expect(summary).toContain('The 15 newest are listed;');
    expect(summary).toContain('(pass repo to narrow)');
    // PRs are not issues
    expect(data.repos.find((r) => r.repo === 'bioc-edge')!.open).toBe(
      fixtureJson('bioc-edge/issues.json').filter((i: any) => !i.pull_request).length,
    );
  });

  test('flags stale and new issues from created_at and updated_at', async () => {
    const { data } = await run('issues', { repo: 'bioc-infrastructure' });
    const raw: any[] = fixtureJson('bioc-infrastructure/issues.json').filter((i: any) => !i.pull_request);
    const since = '2026-10-15';
    expect(data.repos[0]!.new).toBe(raw.filter((i) => i.created_at.slice(0, 10) >= since).length);
    expect(data.repos[0]!.stale).toBe(
      raw.filter((i) => (GITHUB_RECORDED_AT.getTime() - Date.parse(i.updated_at)) / 86_400_000 > 30).length,
    );
    expect(data.items.every((item) => item.stale === (item.updated_age_days > 30))).toBe(true);
  });

  test('a single repo does not say to narrow', async () => {
    const { summary } = await run('issues', { repo: 'bioc-infrastructure' });
    expect(summary).toContain('more are not.');
    expect(summary).not.toContain('pass repo to narrow');
  });

  test('a repo with no issues lists nothing', async () => {
    const { data, summary } = await run('issues', { repo: 'bioc-manifest' });
    expect(data).toMatchObject({ items: [], omitted: 0 });
    expect(summary).toBe('bioc-manifest: 0 open issues, 0 untouched over 30 days, 0 opened in the last 7 days.');
  });
});

function fixtureCreatedAt(repo: string, number: number): string {
  return fixtureJson(`${repo}/issues.json`).find((i: any) => i.number === number).created_at;
}

describe('prs', () => {
  test('classifies bioc-website #74 warn (conflicts) and #14 info (stale)', async () => {
    const { data, summary, sources } = await run('prs');
    const byKey = (repo: string, number: number) => data.items.find((i) => i.repo === repo && i.number === number)!;
    expect(byKey('bioc-website', 74)).toMatchObject({
      mergeable: 'CONFLICTING',
      failing_checks: [],
      status: 'warn',
      reason: 'merge conflicts',
    });
    const stale = byKey('bioc-website', 14);
    expect(stale).toMatchObject({ mergeable: 'MERGEABLE', status: 'info' });
    expect(stale.reason).toMatch(/^no activity for \d+ days$/);
    expect(data.items).toHaveLength(7);
    expect(data.omitted).toBe(0);
    expect(sources).toEqual(repoSources(OPS_REPOS));
    expect(summary).toContain('Need attention: bioc-website#74 (merge conflicts).');
    expect(summary).toContain('7 open PRs (0 draft, 1 non-draft untouched over 14 days)');
  });

  test('failing checks list the check run first, then the status context', async () => {
    const sha = fixtureJson('bioc-website/pulls.json').find((p: any) => p.number === 74).head.sha;
    const routes = {
      ...githubRoutes(),
      [githubUrl('bioc-website', `/commits/${sha}/check-runs?per_page=100`)]: {
        status: 200,
        body: JSON.stringify({
          total_count: 2,
          check_runs: [
            { name: 'build-deploy', status: 'completed', conclusion: 'timed_out' },
            { name: 'lint', status: 'completed', conclusion: 'success' },
          ],
        }),
      },
      [githubUrl('bioc-website', `/commits/${sha}/status`)]: {
        status: 200,
        body: JSON.stringify({ statuses: [{ context: 'ci/legacy', state: 'error' }] }),
      },
    };
    const { data } = await run('prs', { repo: 'bioc-website' }, routes);
    const pr = data.items.find((i) => i.number === 74)!;
    expect(pr.failing_checks).toEqual(['build-deploy', 'ci/legacy']);
    expect(pr.status).toBe('warn');
    expect(pr.reason).toBe('failing checks: build-deploy, ci/legacy; merge conflicts');
  });

  test('a PR whose mergeability is still being computed is UNKNOWN and not a problem', async () => {
    const routes = {
      ...githubRoutes(),
      [githubUrl('bioc-edge', '/pulls/64')]: { status: 200, body: JSON.stringify({ number: 64, mergeable: null }) },
    };
    const { data } = await run('prs', { repo: 'bioc-edge' }, routes);
    expect(data.items[0]).toMatchObject({ number: 64, mergeable: 'UNKNOWN', status: 'ok' });
  });

  test('only the 10 newest PRs are checked; the rest are omitted', async () => {
    const template = fixtureJson('bioc-website/pulls.json')[0];
    const pulls = Array.from({ length: 12 }, (_, i) => ({
      ...template,
      number: 500 + i,
      created_at: `2026-10-${String(10 + i).padStart(2, '0')}T00:00:00Z`,
      head: { sha: `a${i}`, ref: 'x' },
    })).reverse();
    const routes: Record<string, FixtureRoute> = {
      ...githubRoutes(),
      [githubUrl('bioc-mcp', PULLS_SUFFIX)]: { status: 200, body: JSON.stringify(pulls) },
    };
    for (let i = 0; i < 12; i++) {
      routes[githubUrl('bioc-mcp', `/pulls/${500 + i}`)] = { status: 200, body: JSON.stringify({ number: 500 + i, mergeable: true }) };
      routes[githubUrl('bioc-mcp', `/commits/a${i}/check-runs?per_page=100`)] = {
        status: 200,
        body: '{"total_count":0,"check_runs":[]}',
      };
      routes[githubUrl('bioc-mcp', `/commits/a${i}/status`)] = { status: 200, body: '{"statuses":[]}' };
    }
    const { data, summary, fetch } = await run('prs', { repo: 'bioc-mcp' }, routes);
    expect(data.items.map((i) => i.number)).toEqual([511, 510, 509, 508, 507, 506, 505, 504, 503, 502]);
    expect(data.omitted).toBe(2);
    expect(data.repos[0]).toMatchObject({ open: 12 });
    expect(summary).toContain('2 older PRs were not checked.');
    expect(fetch.calls).toHaveLength(1 + 3 * 10);
    expect(fetch.calls.some((url) => url.includes('/pulls/500') || url.includes('/commits/a0/'))).toBe(false);
  });
});

describe('workflows', () => {
  test('with repo, lists every workflow of the default branch', async () => {
    const { data, summary, sources } = await run('workflows', { repo: 'bioc-website' });
    expect(data.listed).toBe('all');
    expect(data.workflows.map((w) => [w.file, w.status])).toEqual([
      ['links.yml', 'fail'],
      ['preview-cleanup.yml', 'info'],
      ['site.yml', 'ok'],
    ]);
    expect(data.workflows[0]).toMatchObject({
      reason: 'latest failure (20 in a row)',
      streak: 20,
      last_success_at: null,
      runs_examined: 20,
      latest_conclusion: 'failure',
    });
    expect(data.workflows[1]).toMatchObject({
      reason: 'no completed runs on main',
      runs_examined: 0,
      latest_conclusion: null,
      latest_run_url: null,
      newest_run_at: null,
    });
    expect(data.repos[0]).toMatchObject({ default_branch: 'main', experimental: false, ok: 1, info: 1, warn: 0, fail: 1 });
    expect(sources).toEqual(repoSources(['bioc-website']));
    expect(summary).toBe(
      'bioc-website: 3 default-branch workflows: 1 failing, 0 warn, 1 with no completed run, 1 ok. ' +
        'Workflows needing attention: bioc-website/links.yml latest failure (20 in a row).',
    );
  });

  test('without repo, lists only workflows that need attention', async () => {
    const { data, summary } = await run('workflows');
    expect(data.listed).toBe('needs_attention');
    expect(data.workflows.map((w) => `${w.repo}/${w.file}:${w.status}`)).toEqual([
      'bioc-website/links.yml:fail',
      'bioc-build/build.yml:warn',
    ]);
    expect(data.omitted).toBe(0);
    expect(summary).toContain('22 default-branch workflows: 1 failing, 1 warn, 3 with no completed run, 17 ok.');
  });

  test('a failure in an experimental repo caps at warn and keeps its last success', async () => {
    const { data, summary } = await run('workflows', { repo: 'bioc-build' });
    expect(data.repos[0]!.experimental).toBe(true);
    const build = data.workflows.find((w) => w.file === 'build.yml')!;
    expect(build).toMatchObject({ status: 'warn', streak: 2, last_success_at: '2026-09-03T17:17:45Z' });
    expect(summary).toContain('(experimental)');
  });

  test('a repo with no workflows has zero counts', async () => {
    const { data, summary } = await run('workflows', { repo: 'bioc-traffic' });
    expect(data.workflows).toEqual([]);
    expect(data.repos[0]).toMatchObject({ ok: 0, info: 0, warn: 0, fail: 0 });
    expect(summary).toContain('0 default-branch workflows');
    expect(summary).toContain('No default-branch workflow needs attention.');
  });

  test('a healthy workflow is ok with no streak', async () => {
    const { data } = await run('workflows', { repo: 'bioc-registry' });
    expect(data.workflows.find((w) => w.file === 'publish.yml')).toMatchObject({
      status: 'ok',
      streak: 0,
      reason: 'latest success',
    });
  });

  test('a disabled workflow is warn and its runs are never requested', async () => {
    const workflows = fixtureJson('bioc-manifest/actions/workflows.json');
    workflows.workflows[0].state = 'disabled_manually';
    const routes = {
      ...githubRoutes(),
      [githubUrl('bioc-manifest', '/actions/workflows?per_page=100')]: { status: 200, body: JSON.stringify(workflows) },
    };
    const { data, fetch } = await run('workflows', { repo: 'bioc-manifest' }, routes);
    expect(data.workflows[0]).toMatchObject({
      status: 'warn',
      state: 'disabled_manually',
      reason: 'workflow is disabled_manually',
      runs_examined: 0,
      streak: 0,
    });
    expect(fetch.calls.some((url) => url.includes('/runs?'))).toBe(false);
  });

  test('a cancelled latest run is warn', async () => {
    const runs = fixtureJson('bioc-registry/actions/runs/publish.yml.json');
    runs.workflow_runs[0].conclusion = 'cancelled';
    const routes = {
      ...githubRoutes(),
      [githubUrl('bioc-registry', '/actions/workflows/publish.yml/runs?branch=main&per_page=20&exclude_pull_requests=true')]: {
        status: 200,
        body: JSON.stringify(runs),
      },
    };
    const { data } = await run('workflows', { repo: 'bioc-registry' }, routes);
    expect(data.workflows.find((w) => w.file === 'publish.yml')).toMatchObject({
      status: 'warn',
      reason: 'latest cancelled',
    });
  });

  test('only .github/workflows/ files count', async () => {
    const workflows = fixtureJson('bioc-manifest/actions/workflows.json');
    workflows.workflows.push({ id: 9, name: 'Dynamic', path: 'dynamic/pages/pages-build-deployment', state: 'active', html_url: 'x' });
    const routes = {
      ...githubRoutes(),
      [githubUrl('bioc-manifest', '/actions/workflows?per_page=100')]: { status: 200, body: JSON.stringify(workflows) },
    };
    const { data } = await run('workflows', { repo: 'bioc-manifest' }, routes);
    expect(data.workflows.map((w) => w.file)).toEqual(['validate.yml']);
  });

  test('more than 12 workflows needing attention are capped and counted as omitted', async () => {
    const workflows = Array.from({ length: 15 }, (_, i) => ({
      id: i,
      name: `w${i}`,
      path: `.github/workflows/w${String(i).padStart(2, '0')}.yml`,
      state: 'disabled_inactivity',
      html_url: 'x',
    }));
    const routes = {
      ...githubRoutes(),
      [githubUrl('bioc-mcp', '/actions/workflows?per_page=100')]: {
        status: 200,
        body: JSON.stringify({ total_count: 15, workflows }),
      },
    };
    const { data } = await run('workflows', { repo: 'bioc-mcp' }, routes);
    expect(data.workflows).toHaveLength(12);
    expect(data.omitted).toBe(3);
  });
});

describe('failures', () => {
  test('lists the units bioc-notify@ filed issues for, newest first', async () => {
    const { data, summary, sources, fetch } = await run('failures');
    expect(data).toMatchObject({ kind: 'failures', repo: 'bioc-edge', omitted: 0 });
    expect(data.items.map((i) => [i.unit, i.number, i.comments])).toEqual([
      ['bioc-sync.service', 69, 0],
      ['bioc-rollup-minute.service', 57, 97],
    ]);
    expect(sources).toEqual(repoSources(['bioc-edge']));
    expect(summary).toContain('2 open "<unit> is failing" issues in bioc-edge: bioc-sync.service, bioc-rollup-minute.service.');
    expect(summary).toContain('nothing closes it on recovery');
    expect(fetch.calls).toEqual([githubUrl('bioc-edge', ISSUES_SUFFIX)]);
  });

  test('repo=bioc-edge is accepted', async () => {
    const { data } = await run('failures', { repo: 'bioc-edge' });
    expect(data.items).toHaveLength(2);
  });

  test('another repo is invalid_input and makes no request', async () => {
    const { deps, fetch } = makeDeps();
    const error = await failure({ kind: 'failures', repo: 'bioc-registry' }, undefined, deps);
    expect(error.code).toBe('invalid_input');
    expect(error.message).toContain('repo=bioc-edge');
    expect(fetch.calls).toEqual([]);
  });

  test('keeps the first issue per unit and ignores PRs and other titles', async () => {
    const author = 'seandavi';
    const issue = (number: number, title: string, createdAt: string, pr = false) => ({
      number,
      title,
      html_url: `https://github.com/seandavi/bioc-edge/issues/${number}`,
      created_at: createdAt,
      updated_at: createdAt,
      comments: 1,
      labels: [],
      user: { login: author },
      ...(pr ? { pull_request: {} } : {}),
    });
    const routes = {
      ...githubRoutes(),
      [githubUrl('bioc-edge', ISSUES_SUFFIX)]: {
        status: 200,
        body: JSON.stringify([
          issue(5, 'a.service is failing', '2026-10-20T00:00:00Z'),
          issue(4, 'b.service is failing', '2026-10-19T00:00:00Z', true),
          issue(3, 'a.service is failing', '2026-10-18T00:00:00Z'),
          issue(2, 'Re: a.service is failing', '2026-10-17T00:00:00Z'),
        ]),
      },
    };
    const { data } = await run('failures', {}, routes);
    expect(data.items.map((i) => [i.unit, i.number])).toEqual([['a.service', 5]]);
  });

  test('ignores issues not opened by the ops owner, and units outside the systemd charset', async () => {
    const routes = edgeIssues([
      failureIssue(6, 'a.service is failing', { author: 'someone-else' }),
      failureIssue(5, 'b.service is failing', { author: null }),
      failureIssue(4, 'bad unit.service is failing'),
      failureIssue(3, `${'x'.repeat(65)}.service is failing`),
      failureIssue(2, 'c.service is failing'),
    ]);
    const { data, summary } = await run('failures', {}, routes);
    expect(data.items.map((i) => i.unit)).toEqual(['c.service']);
    expect(summary).toContain('1 open "<unit> is failing" issue in bioc-edge: c.service.');
  });

  test('60 issues with maximum-length units still fit: summary and failures name at most 15 units', async () => {
    const issues = Array.from({ length: 60 }, (_, i) =>
      failureIssue(100 + i, `${String(i).padStart(2, '0')}${'u'.repeat(62)}.service is failing`),
    );
    const routes = edgeIssues(issues);
    for (const kind of ['failures', 'summary'] as const) {
      const { envelope, summary } = await run(kind, kind === 'summary' ? { repo: 'bioc-edge' } : {}, routes);
      expect(envelopeBytes(envelope)).toBeLessThan(MAX_RESULT_BYTES);
      expect(summary).toContain('60 open "<unit> is failing" issues in bioc-edge');
      expect(summary).toContain('and 45 more');
    }
    const { data } = await run('failures', {}, routes);
    expect(data.items).toHaveLength(15);
    expect(data.omitted).toBe(45);
  });

  test('with none open, says so', async () => {
    const routes = { ...githubRoutes(), [githubUrl('bioc-edge', ISSUES_SUFFIX)]: { status: 200, body: '[]' } };
    const { data, summary } = await run('failures', {}, routes);
    expect(data.items).toEqual([]);
    expect(summary).toBe('0 open "<unit> is failing" issues in bioc-edge.');
  });
});

describe('failure isolation', () => {
  test('an unreadable bioc-edge reports failure_issues null, not 0', async () => {
    const routes = { ...githubRoutes(), [githubUrl('bioc-edge', ISSUES_SUFFIX)]: { status: 500 } as FixtureRoute };
    const { data } = await run('summary', {}, routes);
    const edge = data.repos.find((r) => r.repo === 'bioc-edge')!;
    expect(edge.error).toContain('HTTP 500');
    expect(edge.failure_issues).toBeNull();
  });

  test('one failing repo is reported, the others are intact, and it has no source', async () => {
    const routes = { ...githubRoutes(), [githubUrl('bioc-traffic', ISSUES_SUFFIX)]: { status: 500 } as FixtureRoute };
    const { data, summary, sources } = await run('summary', {}, routes);
    const traffic = data.repos.find((r) => r.repo === 'bioc-traffic')!;
    expect(traffic.error).toContain('HTTP 500');
    expect(traffic).toMatchObject({ open_issues: 0, open_prs: 0, newest: null, failure_issues: null, truncated: false });
    expect(data.repos.filter((r) => r.error === null)).toHaveLength(8);
    expect(sources.map((s) => s.url)).toEqual(OPS_REPOS.filter((r) => r !== 'bioc-traffic').map((r) => githubUrl(r)));
    expect(summary).toContain('Could not read bioc-traffic: GitHub REST API returned HTTP 500');
  });

  test.each(['timeout', 'network-error'] as const)('a %s on one repo is a per-repo error', async (kind) => {
    const url = githubUrl('bioc-registry', ISSUES_SUFFIX);
    const routes = { ...githubRoutes(), [url]: kind };
    const { deps } = makeDeps(routes);
    const inner = deps.fetch;
    deps.fetch = (request) =>
      request.url === url && kind === 'timeout'
        ? Promise.reject(new DOMException('timed out', 'TimeoutError'))
        : inner(request);
    const result = await invokeCapability(opsActivity, { kind: 'issues' }, deps, testContext());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.envelope.data as Of<'issues'>;
    expect(data.repos.find((r) => r.repo === 'bioc-registry')!.error).not.toBeNull();
    expect(data.repos.filter((r) => r.error !== null)).toHaveLength(1);
  });

  test('every repo failing with 403 fails the call, naming the rate limit and the missing token', async () => {
    const routes = Object.fromEntries(Object.keys(githubRoutes()).map((url) => [url, { status: 403 } as FixtureRoute]));
    for (const kind of KINDS) {
      const error = await failure({ kind }, routes);
      expect(error.code).toBe('upstream_error');
      expect(error.message).toContain('rate limit');
      expect(error.message).toContain('GITHUB_TOKEN');
    }
  });

  test('a single-repo timeout is upstream_timeout', async () => {
    const { deps } = makeDeps();
    deps.fetch = () => Promise.reject(new DOMException('timed out', 'TimeoutError'));
    const error = await failure({ kind: 'issues', repo: 'bioc-mcp' }, undefined, deps);
    expect(error.code).toBe('upstream_timeout');
  });

  test('a 404 is upstream_error, never not_found', async () => {
    const routes = { ...githubRoutes(), [githubUrl('bioc-mcp', ISSUES_SUFFIX)]: { status: 404, body: '{}' } as FixtureRoute };
    const error = await failure({ kind: 'issues', repo: 'bioc-mcp' }, routes);
    expect(error.code).toBe('upstream_error');
  });

  test('a PR detail call that fails makes the repo an error, without hiding the others', async () => {
    const routes = { ...githubRoutes(), [githubUrl('bioc-website', '/pulls/74')]: { status: 500 } as FixtureRoute };
    const { data, sources, summary } = await run('prs', {}, routes);
    expect(data.repos.find((r) => r.repo === 'bioc-website')).toMatchObject({ open: 0, error: expect.stringContaining('HTTP 500') });
    expect(data.items.map((i) => i.repo)).not.toContain('bioc-website');
    expect(sources.map((s) => s.url)).not.toContain(githubUrl('bioc-website'));
    expect(summary).toContain('Could not read bioc-website');
  });
});

describe('input', () => {
  test('kind defaults to summary', async () => {
    const result = await invokeCapability(opsActivity, {}, makeDeps().deps, testContext());
    expect(result.ok && (result.envelope.data as Data).kind).toBe('summary');
  });

  test.each([{ repo: 'bioc-nope' }, { kind: 'all' }])('%j is invalid_input with no request', async (input) => {
    const { deps, fetch } = makeDeps();
    expect((await failure(input, undefined, deps)).code).toBe('invalid_input');
    expect(fetch.calls).toEqual([]);
  });
});

/** A bioc-edge issue as GitHub returns it; `author` null is a deleted user. */
function failureIssue(number: number, title: string, { author = 'seandavi' }: { author?: string | null } = {}) {
  const createdAt = new Date(Date.UTC(2026, 9, 1, 0, number)).toISOString();
  return {
    number,
    title,
    html_url: `https://github.com/seandavi/bioc-edge/issues/${number}`,
    created_at: createdAt,
    updated_at: createdAt,
    comments: 1,
    labels: [],
    user: author === null ? null : { login: author },
  };
}

const edgeIssues = (issues: readonly object[]) => ({
  ...githubRoutes(),
  [githubUrl('bioc-edge', ISSUES_SUFFIX)]: { status: 200, body: JSON.stringify(issues) } as FixtureRoute,
});

describe('size', () => {
  test.each(KINDS)('%s stays under 8 KB on the full fixtures', async (kind) => {
    const { envelope } = await run(kind);
    expect(envelopeBytes(envelope)).toBeLessThan(MAX_RESULT_BYTES);
  });
});

describe('caching', () => {
  test('identical calls within 120 s request each URL once; after 121 s again', async () => {
    let nowMs = GITHUB_RECORDED_AT.getTime();
    const { deps, fetch } = makeDeps(githubRoutes(), () => new Date(nowMs));
    const ask = async () => {
      const result = await invokeCapability(opsActivity, { kind: 'workflows', repo: 'bioc-website' }, deps, testContext());
      expect(result.ok).toBe(true);
    };
    await ask();
    const first = fetch.calls.length;
    expect(first).toBe(1 + 1 + 3); // repo, workflows, runs for the 3 active workflows
    nowMs += 119_000;
    await ask();
    expect(fetch.calls).toHaveLength(first);
    nowMs += 2_000;
    await ask();
    expect(fetch.calls).toHaveLength(first * 2);
    expect(new Set(fetch.calls).size).toBe(first);
  });

  test('summary, issues and failures share the bioc-edge issues request', async () => {
    const { deps, fetch } = makeDeps();
    for (const kind of ['summary', 'issues', 'failures'] as const) {
      expect((await invokeCapability(opsActivity, { kind }, deps, testContext())).ok).toBe(true);
    }
    const edgeIssues = githubUrl('bioc-edge', ISSUES_SUFFIX);
    expect(fetch.calls.filter((url) => url === edgeIssues)).toHaveLength(1);
  });
});
