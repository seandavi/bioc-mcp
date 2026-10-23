import { describe, expect, it } from 'vitest';
import { branchCommit, MAX_PAGES_DEPLOYMENTS, pagesCommit } from '../../scripts/docs-index/commits';
import type { Deps, FetchFn } from '../../src/core/deps';
import { CapabilityError } from '../../src/errors';
import { createMemoryCache } from '../../src/upstreams/cache';

const API = 'https://api.github.com/repos/seandavi/site/';
const sha = (c: string) => c.repeat(40);

type Json = unknown;

/** A FetchFn serving JSON by URL (a missing URL is a 404) that records the URLs requested. */
function jsonFetch(routes: Record<string, Json>): FetchFn & { calls: string[] } {
  const calls: string[] = [];
  const fetchFn = (async (request: Request) => {
    calls.push(request.url);
    const route = routes[request.url];
    if (route === undefined) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(route), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as FetchFn & { calls: string[] };
  fetchFn.calls = calls;
  return fetchFn;
}

function depsFor(fetch: FetchFn): Deps {
  const now = () => new Date('2026-10-22T00:00:00Z');
  return { fetch, cache: createMemoryCache(now), now, env: {} };
}

const branch = (head: string, date: string) => ({ name: 'main', commit: { sha: head, commit: { committer: { date } } } });
const deployment = (id: number, deploySha: string, ref = 'main') => ({ id, sha: deploySha, ref, created_at: '2026-10-16T00:00:00Z' });
const deploymentsUrl = `${API}deployments?environment=github-pages&per_page=10`;
const statusesUrl = (id: number) => `${API}deployments/${id}/statuses?per_page=1`;

describe('branchCommit', () => {
  it('maps a branch response to a commit whose sha is its head', async () => {
    const fetch = jsonFetch({ [`${API}branches/main`]: branch(sha('a'), '2026-10-16T23:21:08Z') });
    expect(await branchCommit(depsFor(fetch), 'site', 'main')).toEqual({
      repo: 'seandavi/site',
      ref: 'main',
      sha: sha('a'),
      head_sha: sha('a'),
      head_committed_at: '2026-10-16T23:21:08Z',
    });
    expect(fetch.calls).toEqual([`${API}branches/main`]);
  });
});

describe('pagesCommit', () => {
  it('takes the newest deployment whose newest status is success, and the head of its ref', async () => {
    const fetch = jsonFetch({
      [deploymentsUrl]: [deployment(3, sha('3')), deployment(2, sha('2')), deployment(1, sha('1')), deployment(0, sha('0'))],
      [statusesUrl(3)]: [{ state: 'in_progress' }, { state: 'queued' }],
      [statusesUrl(2)]: [{ state: 'failure' }, { state: 'success' }],
      [statusesUrl(1)]: [{ state: 'success' }, { state: 'in_progress' }],
      [`${API}branches/main`]: branch(sha('f'), '2026-10-20T01:02:03Z'),
    });
    expect(await pagesCommit(depsFor(fetch), 'site')).toEqual({
      repo: 'seandavi/site',
      ref: 'main',
      sha: sha('1'),
      head_sha: sha('f'),
      head_committed_at: '2026-10-20T01:02:03Z',
    });
    // Stops at the first match: deployment 0 is never checked.
    expect(fetch.calls).toEqual([deploymentsUrl, statusesUrl(3), statusesUrl(2), statusesUrl(1), `${API}branches/main`]);
  });

  it('looks up the branch the deployment names', async () => {
    const fetch = jsonFetch({
      [deploymentsUrl]: [deployment(1, sha('1'), 'gh-pages')],
      [statusesUrl(1)]: [{ state: 'success' }],
      [`${API}branches/gh-pages`]: branch(sha('9'), '2026-10-01T00:00:00Z'),
    });
    expect(await pagesCommit(depsFor(fetch), 'site')).toMatchObject({ ref: 'gh-pages', sha: sha('1'), head_sha: sha('9') });
  });

  it('is null, without a branch request, when no deployment qualifies', async () => {
    const fetch = jsonFetch({
      [deploymentsUrl]: [deployment(2, sha('2')), deployment(1, sha('1')), deployment(0, sha('0'))],
      [statusesUrl(2)]: [{ state: 'in_progress' }],
      [statusesUrl(1)]: [],
      [statusesUrl(0)]: [{ state: 'failure' }, { state: 'success' }],
    });
    expect(await pagesCommit(depsFor(fetch), 'site')).toBeNull();
    expect(fetch.calls.some((url) => url.includes('/branches/'))).toBe(false);
  });

  it('is null for a repo with no deployments', async () => {
    expect(await pagesCommit(depsFor(jsonFetch({ [deploymentsUrl]: [] })), 'site')).toBeNull();
  });

  it('requests per_page=10 deployments and per_page=1 statuses', async () => {
    expect(MAX_PAGES_DEPLOYMENTS).toBe(10);
    const fetch = jsonFetch({ [deploymentsUrl]: [deployment(1, sha('1'))], [statusesUrl(1)]: [{ state: 'failure' }] });
    await pagesCommit(depsFor(fetch), 'site');
    expect(fetch.calls).toEqual([deploymentsUrl, statusesUrl(1)]);
  });

  it('throws when a GitHub call fails', async () => {
    const error = await pagesCommit(depsFor(jsonFetch({})), 'site').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CapabilityError);
  });
});
