import type { Deps } from '../../src/core/deps';
import type { DocsInputCommit } from '../../src/docs-index/schema';
import { getBranch, listDeployments, listDeploymentStatuses } from '../../src/upstreams/github';

export const PAGES_ENVIRONMENT = 'github-pages';
/** pagesCommit looks at most this many deployments back for the live one. */
export const MAX_PAGES_DEPLOYMENTS = 10;

/** The head of seandavi/<repo>@<ref>, as stored for a repo file: sha === head_sha. */
export async function branchCommit(deps: Deps, repo: string, ref: string): Promise<DocsInputCommit> {
  const { data } = await getBranch(deps, repo, ref);
  return {
    repo: `seandavi/${repo}`,
    ref,
    sha: data.commit.sha,
    head_sha: data.commit.sha,
    head_committed_at: data.commit.commit.committer.date,
  };
}

/**
 * The commit the live GitHub Pages site of seandavi/<repo> was deployed from: the newest of the
 * newest MAX_PAGES_DEPLOYMENTS 'github-pages' deployments whose newest status is 'success'. Pages
 * deployments made by Actions are not marked inactive when a newer one succeeds, so the newest
 * successful one is the live one. head_sha and head_committed_at come from the deployment's branch.
 * Returns null when no deployment qualifies, without looking up a branch.
 */
export async function pagesCommit(deps: Deps, repo: string): Promise<DocsInputCommit | null> {
  const { data: deployments } = await listDeployments(deps, repo, PAGES_ENVIRONMENT, MAX_PAGES_DEPLOYMENTS);
  for (const deployment of deployments) {
    const { data: statuses } = await listDeploymentStatuses(deps, repo, deployment.id, 1);
    if (statuses[0]?.state !== 'success') continue;
    const { data: branch } = await getBranch(deps, repo, deployment.ref);
    return {
      repo: `seandavi/${repo}`,
      ref: deployment.ref,
      sha: deployment.sha,
      head_sha: branch.commit.sha,
      head_committed_at: branch.commit.commit.committer.date,
    };
  }
  return null;
}
