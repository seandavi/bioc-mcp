import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FixtureRoute } from './fixture-fetch';

const GITHUB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'github');

export const GITHUB_RECORDED_AT = new Date(readFileSync(join(GITHUB_DIR, 'RECORDED_AT'), 'utf8').trim());

export function githubUrl(repo: string, suffix?: string): string {
  return `https://api.github.com/repos/seandavi/${repo}${suffix ?? ''}`;
}

const ISSUES_QUERY = '?state=open&per_page=100&sort=created&direction=desc';

/** URL suffix for a file path under test/fixtures/github/<repo>/; undefined when the file is unknown. */
function suffixFor(path: string, defaultBranch: string): string | undefined {
  const fixed: Record<string, string> = {
    'repo.json': '',
    'issues.json': `/issues${ISSUES_QUERY}`,
    'pulls.json': `/pulls${ISSUES_QUERY}`,
    'actions/workflows.json': '/actions/workflows?per_page=100',
  };
  if (path in fixed) return fixed[path];
  const pull = /^pulls\/(\d+)\.json$/.exec(path);
  if (pull) return `/pulls/${pull[1]}`;
  const commit = /^commits\/([0-9a-f]+)\/(check-runs|status)\.json$/.exec(path);
  if (commit) return `/commits/${commit[1]}/${commit[2] === 'status' ? 'status' : 'check-runs?per_page=100'}`;
  const runs = /^actions\/runs\/([^/]+)\.json$/.exec(path);
  if (runs) {
    return `/actions/workflows/${runs[1]}/runs?branch=${defaultBranch}&per_page=20&exclude_pull_requests=true`;
  }
  return undefined;
}

/** Every recorded GitHub response, keyed by URL. A fresh object each call, so tests can override entries. */
export function githubRoutes(): Record<string, FixtureRoute> {
  const routes: Record<string, FixtureRoute> = {};
  for (const repo of readdirSync(GITHUB_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    const repoDir = join(GITHUB_DIR, repo.name);
    const { default_branch: defaultBranch } = JSON.parse(readFileSync(join(repoDir, 'repo.json'), 'utf8')) as {
      default_branch: string;
    };
    for (const file of readdirSync(repoDir, { recursive: true, withFileTypes: false }) as string[]) {
      const path = file.split('\\').join('/');
      if (!path.endsWith('.json')) continue;
      const suffix = suffixFor(path, defaultBranch);
      if (suffix === undefined) throw new Error(`Unknown GitHub fixture: ${repo.name}/${path}`);
      routes[githubUrl(repo.name, suffix)] = { file: `github/${repo.name}/${path}` };
    }
  }
  return routes;
}
